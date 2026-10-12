import json
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.dependencies import get_current_user
from app.api.schemas.mock_test import GeneratedMockQuestionSet
from app.main import app
from app.services.ai_provider import AIProviderError, GeminiProvider
from app.services.ai_usage import UsageLimitError
from app.services.mock_test import _claim_generation, _finish_generation
from tests.test_syllabus import FakeFirestore, make_syllabus


def make_question_set():
    return {
        "questions": [
            {"prompt": f"Which statement best describes concept {index} in this topic?",
             "options": [f"Correct concept {index}", f"Distractor A {index}", f"Distractor B {index}", f"Distractor C {index}"],
             "answer_index": 0,
             "explanation": f"Concept {index} follows the saved topic description."}
            for index in range(1, 7)
        ]
    }


class MockTestSchemaTests(unittest.TestCase):
    def test_requires_six_questions_four_distinct_options_and_one_answer_index(self):
        valid = GeneratedMockQuestionSet.model_validate(make_question_set())
        self.assertEqual(len(valid.questions), 6)
        self.assertTrue(all(len(question.options) == 4 and 0 <= question.answer_index <= 3 for question in valid.questions))

        duplicate = make_question_set()
        duplicate["questions"][0]["options"][1] = duplicate["questions"][0]["options"][0]
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(duplicate)

        short = make_question_set()
        short["questions"].pop()
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(short)

        invalid_answer = make_question_set()
        invalid_answer["questions"][0]["answer_index"] = 4
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(invalid_answer)


class MockTestEndpointTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeFirestore()
        self.database.docs[self.database.course_path].update(syllabusStatus="ready", syllabusVersion=1)
        self.database.docs[self.database.course_path + "/syllabus/v1"] = make_syllabus().model_dump(mode="json")
        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        self.firestore = patch("app.services.mock_test.get_firestore_client", return_value=self.database)
        self.firestore.start()
        self.addCleanup(self.firestore.stop)
        self.provider = Mock()
        self.provider.generate_structured.return_value = Mock(text=json.dumps(make_question_set()))
        self.provider_patch = patch("app.services.mock_test.get_ai_provider", return_value=self.provider)
        self.provider_patch.start()
        self.addCleanup(self.provider_patch.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(app.dependency_overrides.clear)

    def bank_path(self, topic_id="module-1-topic-1"):
        return f"{self.database.course_path}/mockQuestionBanks/v1_{topic_id}"

    def start(self, topic_id="module-1-topic-1", attempt_id="00000000-0000-4000-8000-000000000001"):
        return self.client.post("/api/mock-test/start", json={
            "courseId": "course-123", "topicId": topic_id, "syllabusVersion": 1, "attemptId": attempt_id,
        })

    def test_unseen_topic_generates_once_then_reuses_saved_bank(self):
        syllabus = make_syllabus().model_dump(mode="json")
        topic = dict(syllabus["modules"][0]["topics"][0], topic_id="module-1-topic-2", title="A newly saved topic")
        syllabus["modules"][0]["topics"][0]["estimated_minutes"] /= 2
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append(topic)
        self.database.docs[self.database.course_path + "/syllabus/v1"] = syllabus
        self.database.docs[self.database.course_path]["course_name"] = "Applied Algebra"

        response = self.start("module-1-topic-2")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(len(response.json()["questions"]), 6)
        self.assertNotIn("answer_index", response.text)
        self.provider.generate_structured.assert_called_once()
        kwargs = self.provider.generate_structured.call_args.kwargs
        self.assertEqual(kwargs["feature"], "mock_test")
        self.assertEqual(kwargs["max_output_tokens"], 1800)
        self.assertTrue(kwargs["request_id"])
        self.assertIn("A newly saved topic", self.provider.generate_structured.call_args.args[0])
        self.assertIn("Applied Algebra", self.provider.generate_structured.call_args.args[0])
        saved = self.database.docs[self.bank_path("module-1-topic-2")]
        self.assertEqual(saved["status"], "ready")
        self.assertEqual(len(saved["questions"]), 6)
        self.assertEqual(self.start("module-1-topic-2").json()["status"], "ready")
        self.provider.generate_structured.assert_called_once()

    def test_saved_syllabus_generation_metadata_is_ignored_during_validation(self):
        # Normal generation persists these operational fields beside the schema.
        self.database.docs[self.database.course_path + "/syllabus/v1"].update({
            "generatedAt": "mock-server-timestamp",
            "provider": "gemini",
            "model": "configured-model",
            "syllabusVersion": 1,
        })
        response = self.client.get("/api/mock-test/bank", params={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "missing")
        self.provider.generate_structured.assert_not_called()

    def test_existing_saved_bank_reuse_and_submit_reveal_answers_without_generation(self):
        self.database.docs[self.bank_path()] = {
            "status": "ready", "syllabus_version": 1, "topic_id": "module-1-topic-1",
            "questions": make_question_set()["questions"],
        }
        public = self.client.get("/api/mock-test/bank", params={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1,
        })
        self.assertEqual(public.status_code, 200)
        self.assertEqual(public.json()["status"], "ready")
        self.assertNotIn("answer_index", public.text)
        self.assertNotIn("explanation", public.text)

        reused = self.start()
        self.assertEqual(reused.json()["status"], "ready")
        self.assertNotIn("answer_index", reused.text)
        submitted = self.client.post("/api/mock-test/submit", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1,
            "answers": {f"q{index}": 0 for index in range(1, 7)},
        })
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual((submitted.json()["total"], submitted.json()["correct"], submitted.json()["percentage"]), (6, 6, 100))
        self.assertEqual(submitted.json()["questions"][0]["explanation"], "Concept 1 follows the saved topic description.")
        self.provider.generate_structured.assert_not_called()

    def test_usage_budget_rejection_is_persisted_and_does_not_call_gemini(self):
        provider = GeminiProvider()
        with patch("app.services.mock_test.get_ai_provider", return_value=provider), patch(
            "app.services.ai_provider.run_tracked_provider_call",
            side_effect=UsageLimitError("The configured daily Gemini request limit has been reached."),
        ) as guarded_call, patch.object(GeminiProvider, "_client") as client:
            response = self.start()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "budget_blocked")
        self.assertEqual(self.database.docs[self.bank_path()]["status"], "budget_blocked")
        guarded_call.assert_called_once()
        client.assert_not_called()
        self.assertEqual(response.json()["questions"], [])

    def test_failed_generation_is_terminal_and_never_retried(self):
        self.provider.generate_structured.side_effect = [
            AIProviderError("gemini", "provider unavailable", 503),
            Mock(text=json.dumps(make_question_set())),
        ]
        first = self.start()
        same_attempt = self.start()
        self.assertEqual(first.json()["status"], "failed")
        self.assertEqual(same_attempt.json()["status"], "failed")
        self.provider.generate_structured.assert_called_once()

        explicit_retry = self.start(attempt_id="00000000-0000-4000-8000-000000000002")
        self.assertEqual(explicit_retry.json()["status"], "ready")
        self.assertEqual(self.provider.generate_structured.call_count, 2)

    def test_invalid_generated_json_is_not_persisted_as_a_ready_bank(self):
        self.provider.generate_structured.return_value = Mock(text='{"questions": []}')
        response = self.start()
        self.assertEqual(response.json()["status"], "failed")
        self.assertNotEqual(self.database.docs[self.bank_path()]["status"], "ready")
        self.provider.generate_structured.assert_called_once()

    def test_stale_attempt_cannot_overwrite_a_new_explicit_attempt(self):
        bank_ref = self.database.document(self.bank_path())
        self.database.docs[self.bank_path()] = {
            "status": "uncertain", "attempt_id": "00000000-0000-4000-8000-000000000001",
            "syllabus_version": 1, "topic_id": "module-1-topic-1", "questions": [],
        }
        _, claimed = _claim_generation(
            self.database.transaction(), bank_ref,
            "00000000-0000-4000-8000-000000000002", 1, "module-1-topic-1",
        )
        self.assertTrue(claimed)
        saved = _finish_generation(self.database.transaction(), bank_ref,
                                   "00000000-0000-4000-8000-000000000001", {"status": "ready", "questions": []})
        self.assertFalse(saved)
        self.assertEqual(self.database.docs[self.bank_path()]["attempt_id"], "00000000-0000-4000-8000-000000000002")
        self.assertEqual(self.database.docs[self.bank_path()]["status"], "generating")

    def test_mock_test_reads_and_submission_do_not_call_provider(self):
        self.database.docs[self.bank_path()] = {
            "status": "ready", "syllabus_version": 1, "topic_id": "module-1-topic-1",
            "questions": make_question_set()["questions"],
        }
        self.client.get("/api/mock-test/bank", params={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1,
        })
        self.client.post("/api/mock-test/submit", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1, "answers": {"q1": 0},
        })
        self.provider.generate_structured.assert_not_called()

    def test_unrelated_course_cannot_read_or_generate_a_bank(self):
        response = self.client.post("/api/mock-test/start", json={
            "courseId": "someone-elses-course", "topicId": "module-1-topic-1", "syllabusVersion": 1,
            "attemptId": "00000000-0000-4000-8000-000000000001",
        })
        self.assertEqual(response.status_code, 404)
        self.provider.generate_structured.assert_not_called()

    def test_stale_syllabus_version_is_rejected_without_provider_call(self):
        response = self.client.post("/api/mock-test/start", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 2,
            "attemptId": "00000000-0000-4000-8000-000000000001",
        })
        self.assertEqual(response.status_code, 409)
        self.provider.generate_structured.assert_not_called()


if __name__ == "__main__":
    unittest.main()
