import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from app.api.schemas.tutor import TutorAction, TutorReply
from app.services.tutor import confirm_concept, ensure_topic_available, teach
from app.services.ai_provider import ProviderResult
from tests.test_syllabus import make_syllabus
from tests.test_syllabus import FakeFirestore
from fastapi.testclient import TestClient
from app.api.dependencies import get_current_user
from app.api.routes import tutor as tutor_route
from app.main import app
from app.services.ai_provider import AIProviderError


def make_reply():
    return TutorReply(concepts=["Values", "Variables"], concept_title="Values",
                      explanation="A value is a piece of data.", example="42 is a number.",
                      check_question="Does a value make sense?")


class TutorSequencingTests(unittest.TestCase):
    def test_confirmation_requires_teaching_and_current_concept(self):
        conversation = {"concepts": ["Values", "Variables"], "concept_index": 0, "taught_index": None}
        with self.assertRaises(ValueError):
            confirm_concept(conversation, 0)
        conversation["taught_index"] = 0
        self.assertFalse(confirm_concept(conversation, 0))
        self.assertEqual(conversation["concept_index"], 1)
        with self.assertRaises(ValueError):
            confirm_concept(conversation, 0)
        conversation["taught_index"] = 1
        self.assertTrue(confirm_concept(conversation, 1))

    def test_can_select_an_incomplete_topic_without_completing_previous_topics(self):
        syllabus = make_syllabus()
        topic = syllabus.modules[0].topics[0].model_copy(update={"topic_id": "module-1-topic-2"})
        syllabus.modules[0].topics.append(topic)
        state = {"topic_status": {}, "confirmed_modules": []}
        self.assertEqual(ensure_topic_available(syllabus, state, topic.topic_id)[1], topic)
        self.assertEqual(state["topic_status"], {})

    def test_reply_is_validated_and_context_is_retrieved(self):
        syllabus = make_syllabus()
        course = {
            "course_name": "Applied Python",
            "learning_goal": "Build useful automation scripts",
            "skill_level": "intermediate",
            "learning_style": "hands-on",
            "additional_requirements": "Use free tools and show practical examples.",
        }
        for action, message in (("start", ""), ("message", "How does this topic apply?")):
            with self.subTest(action=action):
                provider = Mock()
                provider.generate_structured.return_value = ProviderResult(text=make_reply().model_dump_json(), sources=[])
                conversation = {"concepts": [], "concept_index": 0, "messages": []}
                with patch("app.services.tutor.get_ai_provider", return_value=provider):
                    reply = teach(syllabus, syllabus.modules[0], syllabus.modules[0].topics[0],
                                  course, "Swati", conversation, action, message)

                self.assertEqual(reply.concept_title, "Values")
                provider.generate_structured.assert_called_once()
                prompt = provider.generate_structured.call_args.args[0]
                context = json.loads(prompt.split("Context:\n", 1)[1])
                self.assertEqual(context["learner_name"], "Swati")
                self.assertEqual(context["course_name"], "Applied Python")
                self.assertEqual(context["goal"], "Build useful automation scripts")
                self.assertEqual(context["level"], "intermediate")
                self.assertEqual(context["preferences"], "hands-on")
                self.assertEqual(context["objective"], syllabus.objective)
                self.assertEqual(context["additional_requirements"], "Use free tools and show practical examples.")
                self.assertEqual(context["module"]["title"], syllabus.modules[0].title)
                self.assertEqual(context["topic"]["topic_id"], syllabus.modules[0].topics[0].topic_id)
                self.assertEqual(context["topic"]["title"], syllabus.modules[0].topics[0].title)
                self.assertEqual(context["resources"][0]["url"], "https://docs.python.org/3/tutorial/")
                self.assertEqual(context["action"], action)
                self.assertEqual(context["learner_message"], message)
                self.assertEqual(provider.generate_structured.call_args.kwargs["feature"], "tutor")
                self.assertIn("adapt depth and examples to the learner's skill level and learning preferences", prompt)
                self.assertIn("Answer the learner's actual question while staying on the selected topic", prompt)

    def test_missing_optional_course_context_is_safe_and_provider_is_called_once(self):
        syllabus = make_syllabus()
        provider = Mock()
        provider.generate_structured.return_value = ProviderResult(text=make_reply().model_dump_json(), sources=[])
        conversation = {"concepts": [], "concept_index": 0, "messages": []}

        with patch("app.services.tutor.get_ai_provider", return_value=provider):
            teach(syllabus, syllabus.modules[0], syllabus.modules[0].topics[0],
                  {}, "Learner", conversation, "start", "")

        provider.generate_structured.assert_called_once()
        prompt = provider.generate_structured.call_args.args[0]
        context = json.loads(prompt.split("Context:\n", 1)[1])
        self.assertIsNone(context["course_name"])
        self.assertIsNone(context["goal"])
        self.assertIsNone(context["level"])
        self.assertIsNone(context["preferences"])
        self.assertIsNone(context["additional_requirements"])

    def test_prompt_limits_history_to_six_recent_messages_and_compacts_resources(self):
        syllabus = make_syllabus()
        provider = Mock()
        provider.generate_structured.return_value = ProviderResult(text=make_reply().model_dump_json(), sources=[])
        conversation = {
            "concepts": [], "concept_index": 0,
            "messages": [{"role": "user", "text": f"message-{index}", "reply": None} for index in range(10)],
        }
        with patch("app.services.tutor.get_ai_provider", return_value=provider):
            teach(syllabus, syllabus.modules[0], syllabus.modules[0].topics[0], {}, "Learner",
                  conversation, "start", "")
        prompt = provider.generate_structured.call_args.args[0]
        context = json.loads(prompt.split("Context:\n", 1)[1])
        self.assertEqual([item["text"] for item in context["conversation"]], [f"message-{i}" for i in range(4, 10)])
        self.assertEqual(context["resources"], [{
            "title": "Python Tutorial", "url": "https://docs.python.org/3/tutorial/",
        }])

    def test_confirmation_payload_requires_concept_and_rejects_user_id(self):
        payload = {"courseId": "course-123", "topicId": "module-1-topic-1", "operationId": "a" * 32,
                   "revision": 0, "action": "confirm"}
        with self.assertRaises(ValueError):
            TutorAction.model_validate(payload)
        payload.update(conceptIndex=0, userId="other-user")
        with self.assertRaises(ValueError):
            TutorAction.model_validate(payload)


class TutorEndpointTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeFirestore()
        self.database.docs[self.database.course_path].update(syllabusStatus="ready", syllabusVersion=1)
        self.database.docs[self.database.course_path + "/syllabus/v1"] = make_syllabus().model_dump(mode="json")
        self.database.docs["users/authenticated-user"] = {"displayName": "Swati"}
        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        self.database_patch = patch.object(tutor_route, "get_firestore_client", return_value=self.database)
        self.teach_patch = patch.object(tutor_route, "teach", return_value=make_reply())
        self.notes_worker_patch = patch.object(tutor_route, "generate_topic_notes")
        self.database_patch.start()
        self.model = self.teach_patch.start()
        self.notes_worker = self.notes_worker_patch.start()
        self.client = TestClient(app)
        self.counter = 0

    def tearDown(self):
        self.client.close()
        self.database_patch.stop()
        self.teach_patch.stop()
        self.notes_worker_patch.stop()
        app.dependency_overrides.clear()

    def state(self):
        return self.client.get("/api/tutor/state", params={"courseId": "course-123"})

    def action(self, action, **overrides):
        self.counter += 1
        state = self.state().json()
        payload = {"courseId": "course-123", "topicId": "module-1-topic-1", "revision": state["revision"],
                   "operationId": f"{self.counter:032d}", "action": action}
        payload.update(overrides)
        return self.client.post("/api/tutor/action", json=payload)

    def test_opening_does_not_call_model_or_mark_progress(self):
        response = self.state()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["learner_name"], "Swati")
        self.assertEqual(response.json()["topic_status"]["module-1-topic-1"], "not_started")
        self.model.assert_not_called()

    def test_confirm_every_concept_then_confirm_module_and_resume(self):
        state_path = self.database.course_path + "/tutor/state"
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)
        self.assertNotIn("lastStudyAt", self.database.docs.get(state_path, {}))
        self.assertEqual(self.action("start").status_code, 200)
        self.assertNotIn("lastStudyAt", self.database.docs[state_path])
        self.assertEqual(self.state().json()["topic_status"]["module-1-topic-1"], "in_progress")
        second = make_reply().model_copy(update={"concept_title": "Variables"})
        self.model.return_value = second
        confirmed = self.action("confirm", conceptIndex=0)
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.json()["conversation"]["concept_index"], 1)
        self.assertNotIn("lastStudyAt", self.database.docs[state_path])
        self.assertEqual(self.action("confirm_module").status_code, 409)
        final = self.action("confirm", conceptIndex=1)
        self.assertEqual(final.json()["topic_status"]["module-1-topic-1"], "completed")
        self.assertIsInstance(self.database.docs[state_path]["lastStudyAt"], datetime)
        event_path = self.database.course_path + "/tutorCompletions/v1-module-1-topic-1"
        self.assertEqual(self.database.docs[event_path]["lessonTitle"], "Syntax and values")
        self.assertIsInstance(self.database.docs[event_path]["completedAt"], datetime)
        self.assertEqual(final.json()["module_status"]["module-1"], "in_progress")
        note_record = self.database.docs[self.database.course_path + "/notes/module-1-topic-1-v1"]
        self.assertEqual(note_record["title"], "Syntax and values")
        self.assertEqual(note_record["status"], "queued")
        self.notes_worker.assert_called_once_with(
            "authenticated-user", "course-123", "module-1-topic-1", 1,
        )
        self.assertEqual(self.action("confirm_module").json()["module_status"]["module-1"], "completed")
        resumed = self.state().json()
        self.assertEqual(len(resumed["conversation"]["messages"]), 2)
        self.assertEqual(self.model.call_count, 2)

    def test_idempotency_and_pause(self):
        payload = {"courseId": "course-123", "topicId": "module-1-topic-1", "revision": 0,
                   "operationId": "a" * 32, "action": "start"}
        self.assertEqual(self.client.post("/api/tutor/action", json=payload).status_code, 200)
        self.assertEqual(self.client.post("/api/tutor/action", json=payload).status_code, 200)
        self.model.assert_called_once()
        self.assertEqual(self.model.call_args.kwargs["request_id"], payload["operationId"])
        self.assertTrue(self.action("pause").json()["paused"])
        self.assertEqual(self.action("message", message="help").status_code, 409)
        self.assertFalse(self.action("resume").json()["paused"])
        self.assertEqual(self.model.call_count, 1)

    def test_resume_returns_active_state_and_continue_explain_send_each_call_once(self):
        paused = self.action("pause")
        self.assertEqual(paused.status_code, 200)
        self.assertTrue(paused.json()["paused"])
        self.model.assert_not_called()

        resumed = self.action("resume")
        self.assertEqual(resumed.status_code, 200)
        self.assertFalse(resumed.json()["paused"])
        self.model.assert_not_called()

        continued = self.action("start")
        self.assertEqual(continued.status_code, 200)
        self.assertFalse(continued.json()["paused"])
        self.assertEqual(self.model.call_count, 1)

        explained = self.action("explain")
        self.assertEqual(explained.status_code, 200)
        self.assertEqual(self.model.call_count, 2)

        answered = self.action("message", message="How do values work?")
        self.assertEqual(answered.status_code, 200)
        self.assertEqual(self.model.call_count, 3)
        saved_messages = answered.json()["conversation"]["messages"]
        self.assertTrue(any(message["role"] == "user" and message["text"] == "How do values work?" for message in saved_messages))
        self.assertEqual(sum(message["role"] == "assistant" for message in saved_messages), 3)

    def test_provider_failures_preserve_completion_and_are_not_retried(self):
        for code in (400, 429, 503, 504):
            with self.subTest(code=code):
                self.model.side_effect = AIProviderError("gemini", "private diagnostic", code)
                before = self.model.call_count
                response = self.action("start")
                self.assertEqual(response.status_code, 502 if code == 400 else code)
                self.assertNotIn("private diagnostic", response.text)
                self.assertEqual(self.model.call_count, before + 1)
                self.assertFalse(self.state().json()["can_confirm"])
                self.assertFalse(self.state().json()["busy"])

    def test_authentication_and_course_ownership(self):
        self.assertEqual(self.client.get("/api/tutor/state", params={"courseId": "someone-elses-course"}).status_code, 404)
        app.dependency_overrides.clear()
        self.assertEqual(self.state().status_code, 401)

    def test_pending_request_and_stale_revision_do_not_call_model(self):
        self.action("start")
        state_path = self.database.course_path + "/tutor/state"
        self.database.docs[state_path]["pending"] = {"id": "b" * 32, "started_at": datetime.now(timezone.utc)}
        before = self.model.call_count
        self.assertEqual(self.action("message", message="help").status_code, 409)
        self.assertEqual(self.model.call_count, before)
        self.database.docs[state_path]["pending"] = None
        self.assertEqual(self.action("message", message="help", revision=0).status_code, 409)
        self.assertEqual(self.model.call_count, before)

    def test_failed_next_concept_keeps_confirmed_position(self):
        self.action("start")
        self.model.side_effect = AIProviderError("gemini", "unavailable", 504)
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 504)
        state_path = self.database.course_path + "/tutor/state"
        self.assertNotIn("lastStudyAt", self.database.docs[state_path])
        saved = self.state().json()
        self.assertEqual(saved["conversation"]["concept_index"], 1)
        self.assertIsNone(saved["conversation"]["taught_index"])
        self.assertEqual(saved["topic_status"]["module-1-topic-1"], "in_progress")
        self.assertFalse(saved["can_confirm"])
        self.assertEqual(self.action("confirm", conceptIndex=1).status_code, 409)
        self.assertFalse(any("tutorCompletions" in path for path in self.database.docs))

    def test_completion_does_not_replace_a_newer_activity_timestamp(self):
        self.action("start")
        state_path = self.database.course_path + "/tutor/state"
        newer_timestamp = datetime.now(timezone.utc) + timedelta(days=1)
        self.database.docs[state_path]["lastStudyAt"] = newer_timestamp
        self.model.return_value = make_reply().model_copy(update={"concept_title": "Variables"})

        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 200)
        self.assertEqual(self.action("confirm", conceptIndex=1).status_code, 200)
        self.assertEqual(self.database.docs[state_path]["lastStudyAt"], newer_timestamp)

    def test_completion_does_not_add_an_older_tutor_timestamp_than_course_activity(self):
        self.action("start")
        course_path = self.database.course_path
        state_path = course_path + "/tutor/state"
        self.database.docs[course_path]["lastActivityAt"] = datetime.now(timezone.utc) + timedelta(days=1)
        self.model.return_value = make_reply().model_copy(update={"concept_title": "Variables"})

        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 200)
        self.assertEqual(self.action("confirm", conceptIndex=1).status_code, 200)
        self.assertNotIn("lastStudyAt", self.database.docs[state_path])

    def test_invalid_model_data_is_not_persisted_as_teaching(self):
        self.model.side_effect = ValueError("invalid AI JSON")
        self.assertEqual(self.action("start").status_code, 502)
        self.assertEqual(self.state().json()["conversation"]["messages"], [])
        self.assertFalse(self.state().json()["can_confirm"])

    def test_select_later_topic_preserves_previous_conversation_and_completion(self):
        path = self.database.course_path
        saved = self.database.docs[path + "/syllabus/v1"]
        first = saved["modules"][0]["topics"][0]
        first["estimated_minutes"] /= 2
        saved["modules"][0]["topics"].append({**first, "topic_id": "module-1-topic-2", "title": "Variables"})
        self.action("start")
        self.database.docs[path + "/tutor/state"]["topic_status"]["module-1-topic-1"] = "completed"
        previous = self.database.docs[path + "/tutorTopics/module-1-topic-1"].copy()
        response = self.action("select", topicId="module-1-topic-2")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["active_topic_id"], "module-1-topic-2")
        self.assertEqual(response.json()["topic_status"]["module-1-topic-2"], "in_progress")
        self.assertEqual(response.json()["topic_status"]["module-1-topic-1"], "completed")
        self.assertEqual(self.database.docs[path + "/tutorTopics/module-1-topic-1"], previous)
        before = self.model.call_count
        self.assertEqual(self.action("select", topicId="module-1-topic-2").status_code, 200)
        self.assertEqual(self.model.call_count, before)

    def test_failed_message_remains_saved_without_fake_reply(self):
        self.model.side_effect = AIProviderError("gemini", "unavailable", 503)
        response = self.action("message", message="Explain variables")
        self.assertEqual(response.status_code, 503)
        messages = self.state().json()["conversation"]["messages"]
        self.assertEqual(messages, [{"role": "user", "text": "Explain variables", "reply": None}])
        self.model.assert_called_once()

    def test_reply_schema_error_names_field_without_exposing_content(self):
        def invalid_reply(*args, **kwargs):
            TutorReply.model_validate({**make_reply().model_dump(), "example": {"secret": "PRIVATE_CONTENT"}})
        self.model.side_effect = invalid_reply
        response = self.action("message", message="Help")
        self.assertEqual(response.status_code, 502)
        self.assertIn("example: string_type", response.json()["detail"])
        self.assertNotIn("PRIVATE_CONTENT", response.text)

    def test_client_cannot_write_progress_or_another_user_identity(self):
        self.assertEqual(self.action("select", userId="someone-else").status_code, 422)
        self.assertEqual(self.action("confirm_module").status_code, 409)
        self.assertEqual(self.state().json()["module_status"]["module-1"], "not_started")

    def test_firestore_commit_failure_does_not_call_model(self):
        with patch.object(tutor_route, "_prepare", side_effect=RuntimeError("database unavailable")):
            self.assertEqual(self.action("start").status_code, 503)
        self.model.assert_not_called()


class TutorOutputSafetyTests(unittest.TestCase):
    def test_saved_resource_url_followed_by_newline_is_accepted(self):
        syllabus = make_syllabus()
        provider = Mock()
        reply = make_reply().model_copy(update={"example": "See https://docs.python.org/3/tutorial/\nThen try a value."})
        provider.generate_structured.return_value = ProviderResult(text=reply.model_dump_json(), sources=[])
        with patch("app.services.tutor.get_ai_provider", return_value=provider):
            result = teach(syllabus, syllabus.modules[0], syllabus.modules[0].topics[0], {}, "Learner",
                           {"concepts": [], "concept_index": 0, "messages": []}, "start", "")
        self.assertEqual(result.example, reply.example)

    def test_invalid_table_and_unverified_url_are_rejected(self):
        reply = make_reply().model_dump()
        reply["visuals"] = [{"kind": "table", "title": "Values", "columns": ["Value"], "rows": [["one", "two"]]}]
        with self.assertRaises(ValueError):
            TutorReply.model_validate(reply)
        syllabus = make_syllabus()
        provider = Mock()
        reply = make_reply().model_copy(update={"example": "See https://invented.invalid/lesson"})
        provider.generate_structured.return_value = ProviderResult(text=reply.model_dump_json(), sources=[])
        with patch("app.services.tutor.get_ai_provider", return_value=provider):
            with self.assertRaises(ValueError):
                teach(syllabus, syllabus.modules[0], syllabus.modules[0].topics[0], {}, "Learner",
                      {"concepts": [], "concept_index": 0, "messages": []}, "start", "")
