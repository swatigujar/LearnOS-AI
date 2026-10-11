import json
import os
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
import httpx
from pydantic import ValidationError

from app.api.dependencies import get_current_user
from app.api.schemas.research import (
    CourseResearchRequest,
    CourseResearchResult,
    CourseResearchSummary,
)
from app.api.schemas.syllabus import (
    GeneratedSyllabus,
    SyllabusGenerateRequest,
    SyllabusGenerateResponse,
)
from app.api.routes import syllabus as syllabus_route
from app.api.routes import ai as ai_route
from app.main import app
from app.core.config import GEMINI_MODEL
from app.services.syllabus_generator import (
    SyllabusGenerationError,
    generate_syllabus,
    validate_syllabus_for_request,
)
from app.services import ai_provider
from app.services import course_research


def make_request(**overrides):
    values = {
        "course_id": "course-123",
        "course_name": "Python",
        "learning_goal": "Become job-ready",
        "skill_level": "beginner",
        "timeline_days": 30,
        "study_hours_per_day": 1,
        "learning_preferences": ["hands-on"],
        "additional_requirements": None,
    }
    values.update(overrides)
    return SyllabusGenerateRequest(**values)


def make_syllabus(*, duration_days=30, hours=12):
    return GeneratedSyllabus(
        overview="Python Foundations",
        objective="Build and explain small Python programs.",
        duration_days=duration_days,
        total_study_hours=hours,
        prerequisites=[],
        modules=[
            {
                "module_id": "module-1",
                "title": "Core foundations",
                "description": "Build a foundation for Python applications.",
                "estimated_hours": hours,
                "topics": [
                    {
                        "topic_id": "module-1-topic-1",
                        "title": "Syntax and values",
                        "description": "Understand Python syntax and values.",
                        "estimated_minutes": hours * 60,
                    }
                ],
            }
        ],
        resources=[
            {
                "title": "Python Tutorial",
                "url": "https://docs.python.org/3/tutorial/",
                "source_type": "official documentation",
                "description": "Official introduction to Python programming.",
            }
        ],
    )


class SyllabusValidationTests(unittest.TestCase):
    def test_accepts_syllabus_that_fits_available_time(self):
        syllabus = validate_syllabus_for_request(make_syllabus(), make_request())
        self.assertEqual(syllabus.duration_days, 30)

    def test_rejects_syllabus_over_available_study_hours(self):
        with self.assertRaises(SyllabusGenerationError):
            validate_syllabus_for_request(make_syllabus(hours=50), make_request())

    def test_checks_computed_hours_even_with_rounding(self):
        data = make_syllabus(hours=30).model_dump(mode="json")
        data["modules"][0]["estimated_hours"] = 30.005
        data["modules"][0]["topics"][0]["estimated_minutes"] = 1800.3
        with self.assertRaises(SyllabusGenerationError):
            validate_syllabus_for_request(GeneratedSyllabus.model_validate(data), make_request())

    def test_rejects_duration_that_does_not_match_request(self):
        with self.assertRaises(SyllabusGenerationError):
            validate_syllabus_for_request(make_syllabus(duration_days=20), make_request())

    def test_rejects_module_hours_that_do_not_match_topics(self):
        data = make_syllabus().model_dump(mode="json")
        data["modules"][0]["topics"][0]["estimated_minutes"] = 2
        with self.assertRaises(ValidationError):
            GeneratedSyllabus.model_validate(data)

    def test_rejects_invalid_structure_urls_and_time(self):
        for path, value in [
            (("modules",), []),
            (("resources",), []),
            (("resources", 0, "url"), "not-a-url"),
            (("modules", 0, "module_id"), "module-2"),
            (("modules", 0, "topics", 0, "topic_id"), "wrong-order"),
            (("modules", 0, "topics", 0, "estimated_minutes"), 0),
            (("total_study_hours",), float("nan")),
        ]:
            with self.subTest(path=path):
                data = make_syllabus().model_dump(mode="json")
                target = data
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                with self.assertRaises(ValidationError):
                    GeneratedSyllabus.model_validate(data)


class GeminiRequestTests(unittest.TestCase):
    def test_direct_research_uses_gemini_without_google_search_and_captures_usage(self):
        research = {
            "important_topics": ["Python syntax"],
            "key_concepts": ["Variables"],
            "prerequisites": [],
            "recommended_learning_order": ["Syntax", "Variables"],
            "important_subtopics": ["Values"],
            "outcome_topics": ["Automation"],
            "sources": [],
            "resource_suggestions": [],
        }
        interaction = SimpleNamespace(
            output_text=json.dumps(research),
            steps=[],
            usage=SimpleNamespace(model_dump=lambda **kwargs: {
                "total_input_tokens": 120,
                "total_output_tokens": 80,
                "total_tokens": 200,
            }),
        )
        interactions = Mock()
        interactions.create.return_value = interaction

        with patch.object(ai_provider.GeminiProvider, "_client", return_value=SimpleNamespace(interactions=interactions)):
            result = ai_provider.GeminiProvider().research_structured_direct(
                "dynamic learner prompt", CourseResearchResult.model_json_schema()
            )

        payload = interactions.create.call_args.kwargs
        self.assertNotIn("tools", payload)
        self.assertEqual(payload["input"], "dynamic learner prompt")
        self.assertEqual(result.usage["total_input_tokens"], 120)
        self.assertEqual(result.search_queries, [])
        self.assertEqual(result.search_query_count, 0)

    def test_uses_structured_json_without_web_search(self):
        syllabus = make_syllabus()
        response = SimpleNamespace(
            text=syllabus.model_dump_json(),
            usage_metadata=SimpleNamespace(
                prompt_token_count=100, candidates_token_count=50, total_token_count=150,
            ),
        )
        fake_client = Mock()
        fake_client.models.generate_content.return_value = response
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=fake_client):
            generated = ai_provider.GeminiProvider().generate_structured(
                "prompt", GeneratedSyllabus.model_json_schema()
            )

        self.assertEqual(generated.text, syllabus.model_dump_json())
        fake_client.models.generate_content.assert_called_once()
        fake_client.interactions.create.assert_not_called()
        payload = fake_client.models.generate_content.call_args.kwargs
        self.assertGreater(payload["config"].http_options.timeout, 0)
        self.assertLessEqual(payload["config"].http_options.timeout, 120_000)
        self.assertEqual(payload["config"].http_options.retry_options.attempts, 0)
        self.assertIsNone(payload["config"].response_mime_type)
        self.assertIsNone(payload["config"].response_schema)
        self.assertIn("Return only a valid JSON object, without Markdown fences or commentary.", payload["contents"])
        self.assertIn(json.dumps(GeneratedSyllabus.model_json_schema()), payload["contents"])
        self.assertEqual(generated.usage["total_tokens"], 150)

    def test_client_has_a_50_second_request_timeout(self):
        with patch("app.services.ai_provider.genai.Client") as client:
            ai_provider.GeminiProvider()._client()
        http_options = client.call_args.kwargs["http_options"]
        self.assertEqual(http_options.timeout, 50_000)
        self.assertEqual(http_options.retry_options.attempts, 0)

    def test_research_uses_google_search_once_and_passes_actual_inputs(self):
        interaction = SimpleNamespace(
            output_text=json.dumps({
                "important_topics": ["Python syntax"],
                "prerequisites": ["None"],
                "recommended_learning_order": ["Syntax", "Functions"],
                "sources": [{"title": "Python Tutorial", "url": "https://docs.python.org/3/tutorial/"}],
            }),
            steps=[SimpleNamespace(
                type="google_search_call",
                arguments=SimpleNamespace(queries=["Python official tutorial"]),
            )],
            usage=SimpleNamespace(
                model_dump=lambda **kwargs: {"total_input_tokens": 100, "total_output_tokens": 50, "total_tokens": 150},
                grounding_tool_count=[],
            ),
        )
        interactions = Mock()
        interactions.create.return_value = interaction
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="Use free resources",
        )
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=SimpleNamespace(interactions=interactions)):
            result = ai_provider.GeminiProvider().research_structured(
                course_research._research_prompt(request), {"type": "object"}
            )
        interactions.create.assert_called_once()
        payload = interactions.create.call_args.kwargs
        self.assertEqual(payload["tools"], [{"type": "google_search"}])
        self.assertIn('"goalText": "Become job-ready"', payload["input"])
        self.assertIn('"studyHoursPerDay": 1', payload["input"])
        self.assertEqual(result.search_queries, ["Python official tutorial"])
        self.assertEqual(result.search_query_count, 1)

    def test_counts_prompt_tokens_with_gemini(self):
        fake_client = SimpleNamespace(models=SimpleNamespace(count_tokens=Mock(return_value=SimpleNamespace(total_tokens=123))))
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=fake_client):
            count = ai_provider.GeminiProvider().count_input_tokens("research prompt")
        self.assertEqual(count, 123)
        fake_client.models.count_tokens.assert_called_once_with(
            model=GEMINI_MODEL, contents="research prompt"
        )


class CourseResearchEndpointTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()

    def test_forwards_all_form_values_through_research_summary_and_generation(self):
        research = course_research.CourseResearchResult(
            important_topics=["Python syntax"],
            prerequisites=["None"],
            recommended_learning_order=["Syntax", "Functions"],
            sources=[{"title": "Python Tutorial", "url": "https://docs.python.org/3/tutorial/"}],
        )
        summary = CourseResearchSummary(
            summary="Python foundations for practical scripting.",
            important_topics=["Syntax"],
            key_concepts=["Variables"],
            prerequisites=[],
            recommended_learning_order=["Syntax", "Variables"],
            important_subtopics=["Values"],
            outcome_topics=["Automation scripts"],
            resource_suggestions=[],
        )
        syllabus_response = SyllabusGenerateResponse(
            courseId="goal-123",
            syllabusId="v1",
            syllabusVersion=1,
            syllabus=make_syllabus(),
        )
        with (
            patch.object(syllabus_route, "research_course", return_value=("execution-123", research)) as run_research,
            patch.object(syllabus_route, "summarize_research", return_value=summary) as summarize,
            patch.object(syllabus_route, "generate_course_syllabus", return_value=syllabus_response) as generate,
            patch.object(syllabus_route, "get_firestore_client") as get_firestore,
        ):
            response = self.client.post("/api/syllabus/research", json={
                "courseId": "goal-123",
                "courseName": "Python",
                "goalText": "Become job-ready",
                "skillLevel": "beginner",
                "timelineType": "days",
                "targetDays": 30,
                "targetDate": "",
                "studyHoursPerDay": 1,
                "preferredLearningStyle": "hands-on",
                "additionalRequirements": "Use free resources",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["execution_id"], "execution-123")
        self.assertEqual(response.json()["syllabus"]["syllabusId"], "v1")
        sent_request = run_research.call_args.args[0]
        self.assertEqual(sent_request.targetDate, "")
        self.assertEqual(sent_request.additionalRequirements, "Use free resources")
        summarize.assert_called_once_with("execution-123", sent_request, research)
        generation_request = generate.call_args.args[0]
        self.assertEqual(generation_request.executionId, "execution-123")
        self.assertEqual(generation_request.researchSummary, summary)
        self.assertEqual(generate.call_args.args[1], {"uid": "authenticated-user"})
        get_firestore.assert_not_called()

    def test_research_failure_stops_summary_and_syllabus_generation(self):
        with (
            patch.object(syllabus_route, "research_course", side_effect=ai_provider.AIProviderError("gemini", "Gemini failed", 503)),
            patch.object(syllabus_route, "summarize_research") as summarize,
            patch.object(syllabus_route, "generate_course_syllabus") as generate,
        ):
            response = self.client.post("/api/syllabus/research", json={
                "courseId": "goal-123",
                "courseName": "Python",
                "goalText": "Become job-ready",
                "skillLevel": "beginner",
                "timelineType": "days",
                "targetDays": 30,
                "targetDate": "",
                "studyHoursPerDay": 1,
                "preferredLearningStyle": "hands-on",
                "additionalRequirements": "Use free resources",
            })
        self.assertEqual(response.status_code, 502)
        summarize.assert_not_called()
        generate.assert_not_called()

    def test_summarization_failure_stops_syllabus_generation(self):
        with (
            patch.object(syllabus_route, "research_course", return_value=(
                "execution-123",
                CourseResearchResult(
                    important_topics=["Python syntax"],
                    prerequisites=[],
                    recommended_learning_order=["Syntax"],
                    sources=[],
                ),
            )),
            patch.object(syllabus_route, "summarize_research", side_effect=RuntimeError("summary unavailable")),
            patch.object(syllabus_route, "generate_course_syllabus") as generate,
        ):
            response = self.client.post("/api/syllabus/research", json={
                "courseId": "goal-123",
                "courseName": "Python",
                "goalText": "Become job-ready",
                "skillLevel": "beginner",
                "timelineType": "days",
                "targetDays": 30,
                "targetDate": "",
                "studyHoursPerDay": 1,
                "preferredLearningStyle": "hands-on",
                "additionalRequirements": "Use free resources",
            })
        self.assertEqual(response.status_code, 502)
        generate.assert_not_called()

    def test_rejects_unauthenticated_research(self):
        app.dependency_overrides.clear()
        response = self.client.post("/api/syllabus/research", json={})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {
            "status": "failed",
            "code": "AUTHENTICATION_REQUIRED",
            "message": "Please sign in to continue.",
        })

    def test_returns_safe_error_when_firebase_verification_is_unavailable(self):
        app.dependency_overrides.clear()
        with patch("app.core.firebase.auth.verify_id_token", side_effect=RuntimeError("credential details")):
            response = self.client.post(
                "/api/syllabus/research",
                headers={"Authorization": "Bearer test-token"},
                json={},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {
            "status": "failed",
            "code": "AUTHENTICATION_UNAVAILABLE",
            "message": "Authentication could not be verified. Please try again.",
        })

    def test_research_failure_response_does_not_expose_telemetry(self):
        error = ai_provider.AIProviderError("gemini", "Gemini course research failed (HTTP 429).", 429)
        with patch.object(syllabus_route, "research_course", side_effect=error):
            response = self.client.post("/api/syllabus/research", json={
                "courseId": "goal-123",
                "courseName": "Python",
                "goalText": "Become job-ready",
                "skillLevel": "beginner",
                "timelineType": "days",
                "targetDays": 30,
                "targetDate": "",
                "studyHoursPerDay": 1,
                "preferredLearningStyle": "hands-on",
                "additionalRequirements": "Use free resources",
            })
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Course research failed; no syllabus was generated.")
        self.assertNotIn("telemetry", response.json())


class CourseResearchLoggingTests(unittest.TestCase):
    def test_direct_research_prompt_includes_exact_learner_inputs(self):
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Applied Python",
            goalText="Automate weekly spreadsheet reports",
            skillLevel="intermediate",
            timelineType="days",
            targetDays=45,
            targetDate="",
            studyHoursPerDay=1.5,
            preferredLearningStyle="hands-on",
            additionalRequirements="Use only free, official resources",
        )
        prompt = course_research._direct_research_prompt(request)
        for value in (
            "Applied Python",
            "Automate weekly spreadsheet reports",
            "intermediate",
            "45",
            "1.5",
            "hands-on",
            "Use only free, official resources",
        ):
            with self.subTest(value=value):
                self.assertIn(value, prompt)

    def test_summarization_logs_usage_under_research_execution_id(self):
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="Use official docs",
        )
        research = CourseResearchResult(
            important_topics=["Syntax"],
            key_concepts=["Variables"],
            prerequisites=[],
            recommended_learning_order=["Syntax", "Variables"],
            important_subtopics=["Values"],
            outcome_topics=["Automation"],
            sources=[],
            resource_suggestions=[],
        )
        summary = CourseResearchSummary(
            summary="Learn Python foundations for automation.",
            important_topics=["Syntax"],
            key_concepts=["Variables"],
            prerequisites=[],
            recommended_learning_order=["Syntax", "Variables"],
            important_subtopics=["Values"],
            outcome_topics=["Automation"],
            resource_suggestions=[],
        )
        provider_result = ai_provider.ProviderResult(
            text=summary.model_dump_json(),
            sources=[],
            usage={"total_input_tokens": 120, "total_output_tokens": 80, "total_tokens": 200},
        )
        with (
            patch.object(ai_provider.GeminiProvider, "generate_structured", return_value=provider_result),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            result = course_research.summarize_research("execution-123", request, research)
        self.assertEqual(result.summary, summary.summary)
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(record["execution_id"], "execution-123")
        self.assertEqual(record["stage"], "research_summarization")
        self.assertEqual(record["input_tokens"], 120)
        self.assertEqual(record["output_tokens"], 80)
        self.assertEqual(record["total_tokens"], 200)
        self.assertEqual(record["search_query_count"], 0)
        self.assertEqual(record["estimated_cost_usd"], 0.00039)

    def test_logs_provider_usage_search_duration_and_estimated_costs(self):
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="",
        )
        provider_result = ai_provider.ProviderResult(
            text=json.dumps({
                "important_topics": ["Python syntax"],
                "prerequisites": [],
                "recommended_learning_order": ["Syntax"],
                "sources": [{"title": "Python Tutorial", "url": "https://docs.python.org/3/tutorial/"}],
            }),
            sources=[],
            usage={"total_input_tokens": 100, "total_output_tokens": 50, "total_tokens": 150},
            search_queries=[],
            search_query_count=0,
        )
        with (
            patch.object(course_research, "TEMP_DIRECT_GEMINI_RESEARCH", True),
            patch.object(ai_provider.GeminiProvider, "research_structured_direct", return_value=provider_result),
            patch.dict(os.environ, {"USD_TO_INR_RATE": "83.5"}),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            execution_id, _ = course_research.research_course(request)
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(record["execution_id"], execution_id)
        self.assertEqual(record["stage"], "web_research")
        self.assertEqual(record["status"], "success")
        self.assertEqual(record["input_tokens"], 100)
        self.assertEqual(record["output_tokens"], 50)
        self.assertEqual(record["total_tokens"], 150)
        self.assertEqual(record["search_query_count"], 0)
        self.assertEqual(record["search_queries"], [])
        self.assertEqual(record["estimated_cost_usd"], 0.0002625)
        self.assertAlmostEqual(record["estimated_cost_inr"], 0.02191875)
        self.assertIsInstance(record["started_at"], str)
        self.assertIsInstance(record["completed_at"], str)
        self.assertIsInstance(record["duration_ms"], int)
        self.assertGreaterEqual(record["duration_ms"], 0)
        self.assertEqual(record["model"], GEMINI_MODEL)
        self.assertIn(f"EXECUTION: {execution_id}", captured.records[1].getMessage())
        self.assertIn("Estimated USD:     $0.00026250", captured.records[1].getMessage())

    def test_missing_provider_usage_and_search_metadata_are_null(self):
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="",
        )
        provider_result = ai_provider.ProviderResult(
            text=json.dumps({
                "important_topics": ["Python syntax"],
                "prerequisites": [],
                "recommended_learning_order": ["Syntax"],
                "sources": [{"title": "Python Tutorial", "url": "https://docs.python.org/3/tutorial/"}],
            }),
            sources=[],
        )
        with (
            patch.object(course_research, "TEMP_DIRECT_GEMINI_RESEARCH", True),
            patch.object(ai_provider.GeminiProvider, "research_structured_direct", return_value=provider_result),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            course_research.research_course(request)
        record = json.loads(captured.records[0].getMessage())
        for field in (
            "input_tokens", "output_tokens", "total_tokens",
            "estimated_cost_usd", "estimated_cost_inr",
        ):
            with self.subTest(field=field):
                self.assertIsNone(record[field])
            self.assertEqual(record["search_query_count"], 0)
            self.assertEqual(record["search_queries"], [])
        self.assertIn("Input tokens:      unavailable", captured.records[1].getMessage())

    def test_logs_research_api_failure_and_stops(self):
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="",
        )
        provider_error = ai_provider.AIProviderError("gemini", "Gemini course research failed (HTTP 429).", 429)
        with (
            patch.object(course_research, "TEMP_DIRECT_GEMINI_RESEARCH", True),
            patch.object(ai_provider.GeminiProvider, "research_structured_direct", side_effect=provider_error) as research,
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            with self.assertRaises(ai_provider.AIProviderError) as raised:
                course_research.research_course(request)
        research.assert_called_once()
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(len(record["execution_id"]), 32)
        self.assertEqual(record["stage"], "web_research")
        self.assertEqual(record["status"], "failed")
        self.assertIsNone(record["input_tokens"])
        self.assertEqual(record["error_code"], 429)
        self.assertEqual(record["error_message"], str(provider_error))
        self.assertIsInstance(record["duration_ms"], int)
        self.assertIsNotNone(record["completed_at"])
        self.assertIsNone(record["estimated_cost_usd"])
        self.assertIn("Status   Time", captured.records[1].getMessage())
        self.assertIn("Error code:        429", captured.records[1].getMessage())


class GeminiProviderFailureTests(unittest.TestCase):
    def test_syllabus_generation_uses_summary_and_logs_usage(self):
        summary = CourseResearchSummary(
            summary="Python foundations for practical scripting.",
            important_topics=["Syntax"],
            key_concepts=["Variables"],
            prerequisites=[],
            recommended_learning_order=["Syntax", "Variables"],
            important_subtopics=["Values"],
            outcome_topics=["Automation"],
            resource_suggestions=[],
        )
        provider = Mock()
        provider.generate_structured.return_value = ai_provider.ProviderResult(
            text=make_syllabus().model_dump_json(),
            sources=[],
            usage={"total_input_tokens": 200, "total_output_tokens": 100, "total_tokens": 300},
        )
        with (
            patch("app.services.syllabus_generator.get_ai_provider", return_value=provider),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            syllabus_generator_result = generate_syllabus(make_request(), "execution-123", summary)
        self.assertEqual(syllabus_generator_result.overview, "Python Foundations")
        prompt = provider.generate_structured.call_args.args[0]
        self.assertIn("Research summary to use as curriculum context", prompt)
        self.assertIn(summary.summary, prompt)
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(record["execution_id"], "execution-123")
        self.assertEqual(record["stage"], "syllabus_generation")
        self.assertEqual(record["input_tokens"], 200)
        self.assertEqual(record["output_tokens"], 100)
        self.assertEqual(record["total_tokens"], 300)
        self.assertEqual(record["estimated_cost_usd"], 0.000525)

    def test_research_error_preserves_http_status_code(self):
        error = RuntimeError("quota exceeded")
        error.status_code = 429
        error.code = "too_many_requests"
        interactions = Mock()
        interactions.create.side_effect = error
        client = SimpleNamespace(interactions=interactions)

        with patch.object(ai_provider.GeminiProvider, "_client", return_value=client):
            with self.assertRaises(ai_provider.AIProviderError) as raised:
                ai_provider.GeminiProvider().research_structured("prompt", {})

        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn("HTTP 429", str(raised.exception))

    def test_research_failure_is_not_retried(self):
        interactions = Mock()
        interactions.create.side_effect = RuntimeError("provider unavailable")
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=SimpleNamespace(interactions=interactions)):
            with self.assertRaises(ai_provider.AIProviderError):
                ai_provider.GeminiProvider().research_structured("prompt", {})
        interactions.create.assert_called_once()

    def test_generation_timeout_is_reported_clearly(self):
        interaction_client = SimpleNamespace(
            models=SimpleNamespace(generate_content=Mock(side_effect=httpx.ReadTimeout("timed out")))
        )
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=interaction_client):
            with self.assertRaisesRegex(ai_provider.AIProviderError, "120-second request deadline"):
                ai_provider.GeminiProvider().generate_structured("prompt", {})

    def test_transient_failure_is_not_retried(self):
        error = RuntimeError("temporary failure")
        error.code = 504
        client = Mock()
        client.models.generate_content.side_effect = [error, SimpleNamespace(text="{}", usage_metadata=None)]
        with (
            patch.object(ai_provider.GeminiProvider, "_client", return_value=client),
            patch.object(ai_provider, "monotonic", side_effect=[0, 0]),
            self.assertLogs("app.services.ai_provider", level="ERROR"),
        ):
            with self.assertRaises(ai_provider.AIProviderError):
                ai_provider.GeminiProvider().generate_structured("prompt", {})
        calls = client.models.generate_content.call_args_list
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["config"].http_options.timeout, 120_000)

    def test_no_retry_when_deadline_has_insufficient_time(self):
        error = RuntimeError("temporary failure")
        error.code = 503
        client = Mock()
        client.models.generate_content.side_effect = error
        with (
            patch.object(ai_provider.GeminiProvider, "_client", return_value=client),
            patch.object(ai_provider, "monotonic", side_effect=[0, 0, 119.5]),
            self.assertLogs("app.services.ai_provider", level="ERROR"),
        ):
            with self.assertRaises(ai_provider.AIProviderError):
                ai_provider.GeminiProvider().generate_structured("prompt", {})
        client.models.generate_content.assert_called_once()

    def test_generator_dispatches_learner_context_through_provider(self):
        provider = Mock()
        provider.generate_structured.return_value = ai_provider.ProviderResult(
            text=make_syllabus().model_dump_json(), sources=[]
        )
        with patch("app.services.syllabus_generator.get_ai_provider", return_value=provider):
            generated = generate_syllabus(make_request())
        self.assertEqual(generated.overview, "Python Foundations")
        prompt, schema = provider.generate_structured.call_args.args
        self.assertIn('"course_name": "Python"', prompt)
        self.assertIn('"maximum_available_study_hours": 30', prompt)
        self.assertIn("topic descriptions within 40 words", prompt)
        self.assertIn("Use compact JSON without indentation", prompt)
        self.assertIn("Remove repeated explanations, not essential topics or concepts", prompt)
        self.assertEqual(schema["title"], "GeneratedSyllabus")

    def test_direct_generation_logs_usage_with_local_execution_id(self):
        provider = Mock()
        provider.generate_structured.return_value = ai_provider.ProviderResult(
            text=make_syllabus().model_dump_json(), sources=[],
            usage={"total_input_tokens": 200, "total_output_tokens": 100, "total_tokens": 300},
        )
        with (
            patch("app.services.syllabus_generator.get_ai_provider", return_value=provider),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            generate_syllabus(make_request())
        provider.generate_structured.assert_called_once()
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(len(record["execution_id"]), 32)
        self.assertEqual(record["stage"], "syllabus_generation")
        self.assertEqual(record["input_tokens"], 200)
        self.assertEqual(record["output_tokens"], 100)
        self.assertEqual(record["total_tokens"], 300)
        self.assertNotIn("Become job-ready", captured.records[0].getMessage())


class GeminiSdkNoRetryTests(unittest.TestCase):
    def test_syllabus_transient_http_errors_are_not_retried(self):
        for status_code in (503, 504):
            with self.subTest(status_code=status_code):
                client, requests = self.make_client(status_code=status_code)
                with (
                    patch.object(ai_provider.GeminiProvider, "_client", return_value=client),
                    self.assertLogs("app.services.ai_provider", level="WARNING"),
                ):
                    with self.assertRaises(ai_provider.AIProviderError) as raised:
                        ai_provider.GeminiProvider().generate_structured("prompt", {})
                self.assertEqual(raised.exception.status_code, status_code)
                self.assertEqual(len(requests), 1)

    def test_direct_generation_400_is_attempted_once_and_sanitized(self):
        client, requests = self.make_client(status_code=400)
        with (
            patch.object(ai_provider.GeminiProvider, "_client", return_value=client),
            self.assertLogs("app.services.ai_provider", level="ERROR") as captured,
        ):
            with self.assertRaises(ai_provider.AIProviderError) as raised:
                ai_provider.GeminiProvider().generate_structured("private learner prompt", {})
        self.assertEqual(len(requests), 1)
        self.assertIn(":generateContent", str(requests[0].url))
        payload = json.loads(requests[0].content)
        self.assertNotIn("responseMimeType", payload.get("generationConfig", {}))
        self.assertNotIn("responseSchema", payload.get("generationConfig", {}))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(str(raised.exception), "Gemini syllabus generation failed (HTTP 400).")
        self.assertNotIn("private learner prompt", " ".join(captured.output))
        self.assertNotIn("test-gemini-key", " ".join(captured.output))

    def make_client(self, *, status_code=None, failure=None):
        requests = []

        def handle_request(request):
            requests.append(request)
            if failure:
                raise failure(request)
            return httpx.Response(
                status_code,
                json={"error": {"code": status_code, "message": "Gemini request failed"}},
                request=request,
            )

        http_client = httpx.Client(transport=httpx.MockTransport(handle_request))
        genai_client = ai_provider.genai.Client

        def build_client(**kwargs):
            kwargs["http_options"].httpx_client = http_client
            return genai_client(**kwargs)

        with (
            patch("app.services.ai_provider.GEMINI_API_KEY", "test-gemini-key"),
            patch("app.services.ai_provider.genai.Client", side_effect=build_client),
        ):
            client = ai_provider.GeminiProvider()._client()
        self.addCleanup(client.close)
        return client, requests

    def test_503_is_attempted_once_logged_and_stops_research(self):
        client, requests = self.make_client(status_code=503)
        request = CourseResearchRequest(
            courseId="goal-123",
            courseName="Python",
            goalText="Become job-ready",
            skillLevel="beginner",
            timelineType="days",
            targetDays=30,
            targetDate="",
            studyHoursPerDay=1,
            preferredLearningStyle="hands-on",
            additionalRequirements="",
        )

        with (
            patch.object(ai_provider.GeminiProvider, "_client", return_value=client),
            patch.object(ai_provider.GeminiProvider, "count_input_tokens", return_value=123),
            self.assertLogs("learnos.research", level="INFO") as captured,
        ):
            with self.assertRaises(ai_provider.AIProviderError):
                course_research.research_course(request)

        self.assertEqual(len(requests), 1)
        record = json.loads(captured.records[0].getMessage())
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error_code"], 503)

    def test_429_is_attempted_once(self):
        client, requests = self.make_client(status_code=429)
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=client):
            with self.assertRaises(ai_provider.AIProviderError):
                ai_provider.GeminiProvider().research_structured("prompt", {})
        self.assertEqual(len(requests), 1)

    def test_timeout_is_attempted_once(self):
        client, requests = self.make_client(
            failure=lambda request: httpx.ReadTimeout("timed out", request=request)
        )
        with patch.object(ai_provider.GeminiProvider, "_client", return_value=client):
            with self.assertRaises(ai_provider.AIProviderError):
                ai_provider.GeminiProvider().research_structured("prompt", {})
        self.assertEqual(len(requests), 1)

    def test_generation_failure_does_not_call_a_fallback_provider(self):
        provider = Mock()
        provider.generate_structured.side_effect = ai_provider.AIProviderError(
            "gemini", "Gemini request failed.", 429
        )
        with patch(
            "app.services.syllabus_generator.get_ai_provider",
            return_value=provider,
        ) as get_provider:
            with self.assertRaises(SyllabusGenerationError):
                generate_syllabus(make_request())
        get_provider.assert_called_once_with()
        provider.generate_structured.assert_called_once()


class GeminiProviderSelectionTests(unittest.TestCase):
    def test_factory_returns_gemini_provider(self):
        self.assertIsInstance(ai_provider.get_ai_provider(), ai_provider.GeminiProvider)

    @patch.object(ai_route, "get_ai_provider")
    def test_connectivity_endpoint_reports_gemini(self, get_provider):
        get_provider.return_value = SimpleNamespace(
            name="gemini", model=GEMINI_MODEL, test_connection=Mock()
        )
        self.assertEqual(ai_route.test_ai_provider(), {
            "provider": "gemini", "model": GEMINI_MODEL, "status": "ok",
        })


class FakeReference:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self, transaction=None):
        data = deepcopy(self.database.docs.get(self.path))
        return SimpleNamespace(exists=data is not None, to_dict=lambda: data)

    def collection(self, name):
        return SimpleNamespace(document=lambda document_id: FakeReference(self.database, f"{self.path}/{name}/{document_id}"))


class FakeTransaction:
    _read_only = False
    _max_attempts = 1
    _id = b"test-transaction"

    def __init__(self, database):
        self.database = database
        self.writes = []

    def _clean_up(self):
        self.writes = []

    def _begin(self, retry_id=None):
        pass

    def _rollback(self):
        self.writes = []

    def _commit(self):
        if self.database.fail_create and any(kind == "create" for kind, _, _ in self.writes):
            raise RuntimeError("Simulated write failure")
        for kind, reference, values in self.writes:
            if kind == "create" and reference.path in self.database.docs:
                raise RuntimeError("Document already exists")
            data = {
                key: datetime.now(timezone.utc) if value is syllabus_route.firestore.SERVER_TIMESTAMP else deepcopy(value)
                for key, value in values.items()
            }
            self.database.docs.setdefault(reference.path, {}).update(data)

    def set(self, reference, data, merge=False):
        self.writes.append(("set", reference, data))

    def update(self, reference, data):
        self.writes.append(("update", reference, data))

    def create(self, reference, data):
        self.writes.append(("create", reference, data))


class FakeFirestore:
    def __init__(self):
        self.course_path = "users/authenticated-user/courses/course-123"
        self.docs = {self.course_path: make_request().model_dump(mode="json", exclude={"course_id", "learning_preferences"})}
        self.docs[self.course_path]["learning_style"] = "hands-on"
        self.fail_create = False

    def document(self, path):
        return FakeReference(self, path)

    def transaction(self):
        return FakeTransaction(self)


class SyllabusEndpointTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeFirestore()
        self.user_override = lambda: {"uid": "authenticated-user"}
        app.dependency_overrides[get_current_user] = self.user_override
        self.firestore_patch = patch.object(
            syllabus_route,
            "get_firestore_client",
            return_value=self.database,
        )
        self.generator_patch = patch.object(
            syllabus_route,
            "generate_syllabus",
            return_value=make_syllabus(),
        )
        self.firestore_patch.start()
        self.generator = self.generator_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.firestore_patch.stop()
        self.generator_patch.stop()
        app.dependency_overrides.clear()

    def test_saves_validated_syllabus_to_authenticated_course(self):
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual((body["courseId"], body["syllabusId"], body["syllabusVersion"], body["status"]), ("course-123", "v1", 1, "ready"))
        course = self.database.docs[self.database.course_path]
        self.assertEqual(course["syllabusStatus"], "ready")
        self.assertEqual(course["syllabusVersion"], 1)
        self.assertIn("createdAt", course)
        saved_syllabus = self.database.docs[self.database.course_path + "/syllabus/v1"]
        self.assertEqual(saved_syllabus["overview"], "Python Foundations")
        self.assertEqual(saved_syllabus["modules"][0]["topics"][0]["title"], "Syntax and values")
        self.assertEqual(saved_syllabus["provider"], "gemini")
        self.assertEqual(saved_syllabus["model"], GEMINI_MODEL)
        self.assertIn("generatedAt", saved_syllabus)
        sent = self.generator.call_args.args[0]
        self.assertEqual((sent.course_name, sent.learning_goal, sent.timeline_days, sent.study_hours_per_day), ("Python", "Become job-ready", 30, 1))
        self.assertEqual(sent.learning_preferences, ["hands-on"])

    def test_existing_ready_syllabus_is_returned_without_regeneration(self):
        first = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        saved = deepcopy(self.database.docs[self.database.course_path + "/syllabus/v1"])
        second = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(first.json(), second.json())
        self.generator.assert_called_once()
        self.assertEqual(saved, self.database.docs[self.database.course_path + "/syllabus/v1"])

    def test_direct_generation_bypasses_research_and_saves_provider_output(self):
        provider = Mock()
        provider.generate_structured.return_value = ai_provider.ProviderResult(
            text=make_syllabus().model_dump_json(), sources=[],
        )
        self.generator.side_effect = generate_syllabus
        with (
            patch("app.services.syllabus_generator.get_ai_provider", return_value=provider),
            patch.object(syllabus_route, "research_course") as research,
            patch.object(syllabus_route, "summarize_research") as summary,
        ):
            first = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
            second = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), second.json())
        research.assert_not_called()
        summary.assert_not_called()
        provider.generate_structured.assert_called_once()
        prompt, schema = provider.generate_structured.call_args.args
        self.assertIn('"learning_goal": "Become job-ready"', prompt)
        self.assertNotIn("Research summary to use", prompt)
        self.assertEqual(schema, GeneratedSyllabus.model_json_schema())
        course = self.database.docs[self.database.course_path]
        self.assertEqual(course["syllabusStatus"], "ready")
        self.assertEqual(course["syllabusVersion"], 1)
        self.assertEqual(
            self.database.docs[self.database.course_path + "/syllabus/v1"]["resources"],
            make_syllabus().model_dump(mode="json")["resources"],
        )

    def test_direct_provider_failure_is_sanitized_and_marks_failed(self):
        provider = Mock()
        provider.generate_structured.side_effect = ai_provider.AIProviderError(
            "gemini", "Gemini syllabus generation failed (HTTP 400).", 400,
        )
        self.generator.side_effect = generate_syllabus
        with patch("app.services.syllabus_generator.get_ai_provider", return_value=provider):
            response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Gemini syllabus generation failed (HTTP 400).")
        provider.generate_structured.assert_called_once()
        course = self.database.docs[self.database.course_path]
        self.assertEqual(course["syllabusStatus"], "failed")
        self.assertEqual(course["syllabusVersion"], 0)
        self.assertNotIn(self.database.course_path + "/syllabus/v1", self.database.docs)

    def test_invalid_syllabus_is_not_saved_and_retry_succeeds(self):
        self.generator.return_value = make_syllabus(hours=40)
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.database.docs[self.database.course_path]["syllabusStatus"], "failed")
        self.assertNotIn(self.database.course_path + "/syllabus/v1", self.database.docs)
        self.generator.return_value = make_syllabus()
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["syllabusVersion"], 1)

    def test_provider_failure_sets_failed_status(self):
        self.generator.side_effect = SyllabusGenerationError("Gemini generation failed.")
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.database.docs[self.database.course_path]["syllabusStatus"], "failed")

    def test_save_failure_sets_failed_without_partial_syllabus(self):
        self.database.fail_create = True
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.database.docs[self.database.course_path]["syllabusStatus"], "failed")
        self.assertNotIn(self.database.course_path + "/syllabus/v1", self.database.docs)

    def test_concurrent_request_does_not_generate_twice(self):
        course = self.database.docs[self.database.course_path]
        course.update(syllabusStatus="generating", syllabusGenerationStartedAt=datetime.now(timezone.utc))
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 409)
        self.generator.assert_not_called()

    def test_stale_attempt_can_be_retried(self):
        self.database.docs[self.database.course_path].update(
            syllabusStatus="generating",
            syllabusGenerationStartedAt=datetime.now(timezone.utc) - timedelta(minutes=11),
        )
        self.assertEqual(self.client.post("/api/syllabus/generate", json={"courseId": "course-123"}).status_code, 200)

    def test_missing_or_other_users_course_is_not_accessible(self):
        self.database.docs["users/other-user/courses/private"] = self.database.docs[self.database.course_path]
        response = self.client.post("/api/syllabus/generate", json={"courseId": "private"})
        self.assertEqual(response.status_code, 404)
        self.generator.assert_not_called()

    def test_rejects_user_id_course_details_and_path_injection(self):
        for payload in [
            {"courseId": "course-123", "userId": "other-user"},
            {"courseId": "course-123", "course_name": "Different"},
            {"courseId": "../private"},
        ]:
            self.assertEqual(self.client.post("/api/syllabus/generate", json=payload).status_code, 422)
        self.generator.assert_not_called()

    def test_legacy_course_is_copied_without_changing_creation_data(self):
        legacy_path = "users/authenticated-user/learningGoals/course-123"
        legacy = {"courseName": "Python", "goalText": "Become job-ready", "skillLevel": "Beginner", "targetDays": 30, "studyHoursPerDay": 1}
        self.database.docs = {legacy_path: deepcopy(legacy)}
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.database.docs[legacy_path], legacy)
        self.assertEqual(self.database.docs[self.database.course_path]["course_name"], "Python")

    def test_invalid_stored_course_sets_failed(self):
        self.database.docs[self.database.course_path]["study_hours_per_day"] = 0
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.database.docs[self.database.course_path]["syllabusStatus"], "failed")
        self.generator.assert_not_called()

    def test_changed_course_during_generation_is_not_saved(self):
        legacy_path = "users/authenticated-user/learningGoals/course-123"
        legacy = {"courseName": "Python", "goalText": "Become job-ready", "skillLevel": "beginner", "targetDays": 30, "studyHoursPerDay": 1}
        self.database.docs = {legacy_path: legacy}

        def change_course(request):
            legacy["targetDays"] = 20
            return make_syllabus()

        self.generator.side_effect = change_course
        response = self.client.post("/api/syllabus/generate", json={"courseId": "course-123"})
        self.assertEqual(response.status_code, 409)
        self.assertNotIn(self.database.course_path + "/syllabus/v1", self.database.docs)
        self.assertEqual(self.database.docs[self.database.course_path]["syllabusStatus"], "failed")

    def test_rejects_missing_bearer_token(self):
        app.dependency_overrides.clear()
        response = self.client.post(
            "/api/syllabus/generate",
            json={"courseId": "course-123"},
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()