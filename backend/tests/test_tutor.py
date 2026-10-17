import json
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from app.api.schemas.tutor import GeneratedTutorReply, TutorAction, TutorLiveTranscriptRequest, TutorReply
from app.services import live_tutor
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
        with self.assertRaises(ValueError):
            confirm_concept(conversation, 0)
        conversation["answered_index"] = 0
        self.assertFalse(confirm_concept(conversation, 0))
        self.assertEqual(conversation["concept_index"], 1)
        with self.assertRaises(ValueError):
            confirm_concept(conversation, 0)
        conversation["taught_index"] = 1
        conversation["answered_index"] = 1
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
                self.assertIn("Adapt pacing to their level, preferences, saved course progress, and recent history", prompt)
                self.assertIn("Answer the learner's actual question before continuing", prompt)

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

    def test_prompt_limits_history_to_ten_recent_messages_and_compacts_resources(self):
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
        self.assertEqual([item["text"] for item in context["conversation"]], [f"message-{i}" for i in range(10)])
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

    def test_live_transcript_requires_bounded_turns(self):
        payload = {
            "courseId": "course-123", "topicId": "module-1-topic-1", "operationId": "b" * 32,
            "turns": [{"role": role, "text": "A short turn."} for role in ("user", "assistant", "user")],
        }
        with self.assertRaises(ValueError):
            TutorLiveTranscriptRequest.model_validate(payload)


class GeminiLiveTokenTests(unittest.TestCase):
    def test_live_token_is_single_use_locked_to_model_and_configured_prompt(self):
        response = Mock(status_code=200)
        response.json.return_value = {"name": "auth_tokens/ephemeral-token"}
        instruction = "Use only the saved course lesson and teach conversationally."

        def tracked_call(**kwargs):
            self.tracking_call = kwargs
            return kwargs["invoke"]()

        with patch.object(live_tutor, "GEMINI_API_KEY", "server-secret"), \
                patch.object(live_tutor, "GEMINI_LIVE_MODEL", "gemini-3.8-live"), \
                patch.object(live_tutor, "GEMINI_LIVE_SESSION_COST_RESERVE_USD", 0.5), \
                patch.object(live_tutor, "run_tracked_provider_call", side_effect=tracked_call), \
                patch.object(live_tutor.httpx, "post", return_value=response) as post:
            token = live_tutor.create_live_access_token(instruction)

        self.assertEqual(token, "auth_tokens/ephemeral-token")
        self.assertEqual(post.call_args.args[0], "https://generativelanguage.googleapis.com/v1beta/auth_tokens")
        self.assertEqual(post.call_args.kwargs["headers"]["x-goog-api-key"], "server-secret")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["uses"], 1)
        self.assertNotIn("liveConnectConstraints", payload)
        setup = payload["bidiGenerateContentSetup"]
        self.assertEqual(setup["model"], "models/gemini-3.8-live")
        self.assertEqual(setup["generationConfig"], {"maxOutputTokens": 2048, "responseModalities": ["AUDIO"]})
        self.assertEqual(setup["systemInstruction"]["parts"], [{"text": instruction}])
        self.assertEqual(setup["inputAudioTranscription"], {})
        self.assertEqual(setup["outputAudioTranscription"], {})
        self.assertEqual(self.tracking_call["feature"], "tutor_live_session")
        self.assertEqual(self.tracking_call["fixed_cost_usd"], 0.5)

    def test_missing_gemini_key_fails_without_requesting_a_token(self):
        with patch.object(live_tutor, "GEMINI_API_KEY", None), \
                patch.object(live_tutor.httpx, "post") as post:
            with self.assertRaises(AIProviderError):
                live_tutor.create_live_access_token("instruction")
        post.assert_not_called()


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

    def live_transcript(self, turns, operation_id="c" * 32, progress_epoch=0, usage=None):
        body = {
            "courseId": "course-123", "topicId": "module-1-topic-1",
            "progressEpoch": progress_epoch, "operationId": operation_id, "turns": turns,
        }
        if usage is not None:
            body["usage"] = usage
        return self.client.post("/api/tutor/live/transcript", json=body)

    def test_opening_does_not_call_model_or_mark_progress(self):
        response = self.state()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["learner_name"], "Swati")
        self.assertEqual(response.json()["topic_status"]["module-1-topic-1"], "not_started")
        self.model.assert_not_called()

    def test_restart_resets_progress_and_hides_prior_topic_conversation(self):
        self.action("start")
        state_path = self.database.course_path + "/tutor/state"
        self.database.docs[state_path]["topic_status"] = {"module-1-topic-1": "completed"}
        self.database.docs[state_path]["confirmed_modules"] = ["module-1"]
        restarted = self.action("restart")

        self.assertEqual(restarted.status_code, 200)
        self.assertEqual(restarted.json()["progress_epoch"], 1)
        self.assertEqual(restarted.json()["active_topic_id"], "module-1-topic-1")
        self.assertEqual(restarted.json()["topic_status"]["module-1-topic-1"], "not_started")
        self.assertEqual(restarted.json()["module_status"]["module-1"], "not_started")
        self.assertEqual(restarted.json()["conversation"]["messages"], [])
        self.assertEqual(self.model.call_count, 1)

    def test_chat_request_switches_to_exact_saved_syllabus_topic(self):
        path = self.database.course_path
        syllabus = self.database.docs[path + "/syllabus/v1"]
        topic = syllabus["modules"][0]["topics"][0]
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append({**topic, "topic_id": "module-1-topic-2", "title": "Variables"})
        self.action("start")

        switched = self.action("message", message="Let's learn Variables next.")

        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()["active_topic_id"], "module-1-topic-2")
        self.assertEqual(switched.json()["conversation"]["messages"][-1]["text"],
                         "Sure, let's switch to Variables. We can continue this lesson whenever you like.")
        self.assertEqual(self.database.docs[path + "/tutorTopics/module-1-topic-1"]["messages"][-1]["text"],
                         "Let's learn Variables next.")
        self.assertEqual(self.model.call_count, 1)

    def test_chat_request_switches_with_a_shortened_topic_name(self):
        path = self.database.course_path
        syllabus = self.database.docs[path + "/syllabus/v1"]
        topic = syllabus["modules"][0]["topics"][0]
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append({
            **topic, "topic_id": "module-1-topic-2", "title": "Functions and Parameters",
        })

        switched = self.action("message", message="Can we learn functions now?")

        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()["active_topic_id"], "module-1-topic-2")
        self.assertEqual(self.model.call_count, 0)

    def test_chat_request_can_switch_to_the_next_syllabus_topic(self):
        path = self.database.course_path
        syllabus = self.database.docs[path + "/syllabus/v1"]
        topic = syllabus["modules"][0]["topics"][0]
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append({
            **topic, "topic_id": "module-1-topic-2", "title": "Variables",
        })

        switched = self.action("message", message="Let's move to the next topic.")

        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()["active_topic_id"], "module-1-topic-2")

    def test_unrelated_chat_request_redirects_without_unlocking_confirmation(self):
        self.model.return_value = make_reply().model_copy(update={
            "intent": "redirect",
            "redirect_message": "I'm unable to say anything about that. Would you like to continue this topic?",
        })
        response = self.action("message", message="Tell me today's weather.")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["conversation"]["messages"][-1]["reply"]["intent"], "redirect")
        self.assertFalse(response.json()["can_confirm"])

    def test_start_teaches_but_waits_for_a_learner_turn_before_confirmation(self):
        started = self.action("start")
        self.assertEqual(started.status_code, 200)
        self.assertFalse(started.json()["can_confirm"])
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)
        answered = self.action("message", message="I think a value is data.")
        self.assertEqual(answered.status_code, 200)
        self.assertTrue(answered.json()["can_confirm"])

    def test_historical_long_reply_loads_and_does_not_disable_actions(self):
        reply = make_reply().model_dump()
        reply.update(explanation="x" * 3000, example="x" * 2000, check_question="x" * 500)
        self.database.docs[self.database.course_path + "/tutorTopics/module-1-topic-1"] = {
            "messages": [{"role": "assistant", "reply": reply}],
        }
        response = self.state()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["conversation"]["messages"][0]["reply"], reply)
        self.assertEqual(self.action("pause").status_code, 200)
        self.assertEqual(self.action("resume").status_code, 200)
        self.model.assert_not_called()
        with self.assertRaises(ValueError):
            GeneratedTutorReply.model_validate(reply)

    def test_start_waits_for_answer_without_repeating_or_advancing(self):
        started = self.action("start").json()
        for _ in range(3):
            repeated = self.action("start")
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(repeated.json()["conversation"], started["conversation"])
        self.model.assert_called_once()
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)
        self.assertEqual(self.state().json()["conversation"]["concept_index"], 0)

    def test_legacy_taught_index_without_answer_cannot_advance(self):
        reply = make_reply().model_dump()
        self.database.docs[self.database.course_path + "/tutorTopics/module-1-topic-1"] = {
            "concepts": reply["concepts"], "concept_index": 0, "taught_index": 0,
            "messages": [{"role": "assistant", "reply": reply}],
        }
        self.assertFalse(self.state().json()["can_confirm"])
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)
        self.assertTrue(self.action("message", message="A value is data.").json()["can_confirm"])

    def test_explanation_is_not_an_answer_and_does_not_advance(self):
        self.action("start")
        explained = self.action("explain").json()
        self.assertFalse(explained["can_confirm"])
        self.assertIsNone(explained["conversation"]["answered_index"])
        self.assertEqual(explained["conversation"]["concept_index"], 0)
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)

    def test_each_new_concept_requires_a_new_answer(self):
        self.action("start")
        self.action("message", message="A value is data.")
        self.model.return_value = make_reply().model_copy(update={"concept_title": "Variables"})
        advanced = self.action("confirm", conceptIndex=0).json()
        self.assertEqual(advanced["conversation"]["concept_index"], 1)
        self.assertFalse(advanced["can_confirm"])
        self.assertIsNone(advanced["conversation"]["answered_index"])
        self.assertEqual(self.action("confirm", conceptIndex=1).status_code, 409)
        self.assertEqual(self.state().json()["topic_status"]["module-1-topic-1"], "in_progress")

    def test_confirm_every_concept_then_confirm_module_and_resume(self):
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 409)
        self.assertEqual(self.action("start").status_code, 200)
        self.assertEqual(self.state().json()["topic_status"]["module-1-topic-1"], "in_progress")
        self.assertEqual(self.action("message", message="A value is data.").status_code, 200)
        second = make_reply().model_copy(update={"concept_title": "Variables"})
        self.model.return_value = second
        confirmed = self.action("confirm", conceptIndex=0)
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.json()["conversation"]["concept_index"], 1)
        self.assertEqual(self.action("confirm_module").status_code, 409)
        self.assertEqual(self.action("message", message="A variable names a value.").status_code, 200)
        final = self.action("confirm", conceptIndex=1)
        self.assertEqual(final.json()["topic_status"]["module-1-topic-1"], "completed")
        self.assertEqual(final.json()["module_status"]["module-1"], "in_progress")
        note_record = self.database.docs[self.database.course_path + "/notes/module-1-topic-1-v1"]
        self.assertEqual(note_record["title"], "Syntax and values")
        self.assertEqual(note_record["status"], "queued")
        self.notes_worker.assert_called_once_with(
            "authenticated-user", "course-123", "module-1-topic-1", 1,
        )
        self.assertEqual(self.action("confirm_module").json()["module_status"]["module-1"], "completed")
        resumed = self.state().json()
        self.assertEqual(len(resumed["conversation"]["messages"]), 6)
        self.assertEqual(self.model.call_count, 4)

    def test_live_transcript_saves_both_sides_without_inventing_a_concept_plan(self):
        response = self.live_transcript([
            {"role": "user", "text": "Can you explain this in another way?"},
            {"role": "assistant", "text": "Sure, imagine a label on a box."},
        ])
        self.assertEqual(response.status_code, 200)
        saved = response.json()
        self.assertEqual(saved["conversation"]["concepts"], [])
        self.assertFalse(saved["can_confirm"])
        self.assertEqual([message["channel"] for message in saved["conversation"]["messages"]], ["voice", "voice"])
        history = [value for path, value in self.database.docs.items()
                   if path.startswith(self.database.course_path + "/tutorHistory/")]
        self.assertEqual(len(history), 2)
        self.assertEqual({turn["channel"] for turn in history}, {"voice"})
        self.assertEqual(self.state().json()["topic_status"]["module-1-topic-1"], "in_progress")
        self.assertEqual(self.model.call_count, 0)

    def test_live_usage_metadata_is_logged_once_with_transcript_retries(self):
        turns = [
            {"role": "user", "text": "Explain this concept."},
            {"role": "assistant", "text": "Let's work through it together."},
        ]
        usage = {
            "input_tokens": 100,
            "output_tokens": 40,
            "thinking_tokens": 8,
            "total_tokens": 148,
            "prompt_tokens_details": [{"modality": "AUDIO", "token_count": 100}],
            "response_tokens_details": [{"modality": "AUDIO", "token_count": 40}],
        }
        with patch.object(tutor_route, "log_live_usage") as log_usage:
            first = self.live_transcript(turns, operation_id="d" * 32, usage=usage)
            retry = self.live_transcript(turns, operation_id="d" * 32, usage=usage)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(retry.status_code, 200, retry.text)
        log_usage.assert_called_once()
        self.assertEqual(log_usage.call_args.kwargs["usage"]["total_tokens"], 148)

    def test_live_transcript_can_switch_to_named_syllabus_topic(self):
        path = self.database.course_path
        syllabus = self.database.docs[path + "/syllabus/v1"]
        topic = syllabus["modules"][0]["topics"][0]
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append({**topic, "topic_id": "module-1-topic-2", "title": "Variables"})

        response = self.live_transcript([
            {"role": "user", "text": "Let's learn Variables next."},
            {"role": "assistant", "text": "Sure, let's move to Variables."},
        ])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["active_topic_id"], "module-1-topic-2")

    def test_live_transcript_from_before_restart_is_rejected(self):
        self.assertEqual(self.action("restart").status_code, 200)
        response = self.live_transcript([
            {"role": "user", "text": "Old voice session."},
            {"role": "assistant", "text": "Old response."},
        ])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.state().json()["conversation"]["messages"], [])

    def test_live_transcript_only_unlocks_confirmation_after_a_saved_two_way_chat_plan(self):
        self.assertEqual(self.action("start").status_code, 200)
        self.assertFalse(self.state().json()["can_confirm"])
        response = self.live_transcript([
            {"role": "user", "text": "I think values are data."},
            {"role": "assistant", "text": "That is right. What is one example?"},
        ])
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["can_confirm"])
        duplicate = self.live_transcript([
            {"role": "user", "text": "I think values are data."},
            {"role": "assistant", "text": "That is right. What is one example?"},
        ])
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(len(duplicate.json()["conversation"]["messages"]), 3)

    def test_live_transcript_can_finish_saving_after_the_learner_selects_another_topic(self):
        path = self.database.course_path
        syllabus = self.database.docs[path + "/syllabus/v1"]
        topic = syllabus["modules"][0]["topics"][0]
        topic["estimated_minutes"] /= 2
        syllabus["modules"][0]["topics"].append({**topic, "topic_id": "module-1-topic-2", "title": "Variables"})
        selected = self.action("select", topicId="module-1-topic-2")
        self.assertEqual(selected.status_code, 200)
        saved = self.live_transcript([
            {"role": "user", "text": "Can we return to this point later?"},
            {"role": "assistant", "text": "Yes, we can pick up here next time."},
        ])
        self.assertEqual(saved.status_code, 200)
        old_topic = self.database.docs[path + "/tutorTopics/module-1-topic-1"]
        self.assertEqual(len(old_topic["messages"]), 2)
        self.assertEqual(saved.json()["active_topic_id"], "module-1-topic-2")

    def test_live_session_uses_saved_course_context_and_single_use_token(self):
        with patch.object(tutor_route, "GEMINI_LIVE_ENABLED", True), \
                patch.object(tutor_route, "create_live_access_token", return_value="one-use-token") as create_token:
            response = self.client.post("/api/tutor/live/session", json={
                "courseId": "course-123", "topicId": "module-1-topic-1",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accessToken"], "one-use-token")
        self.assertEqual(response.json()["model"], tutor_route.GEMINI_LIVE_MODEL)
        instruction = create_token.call_args.args[0]
        self.assertIn("Address the learner by their saved name", instruction)
        self.assertIn("Swati", instruction)
        self.assertIn("Syntax and values", instruction)
        self.assertIn("Python Tutorial", instruction)

    def test_live_session_rate_limit_returns_friendly_message(self):
        with patch.object(tutor_route, "GEMINI_LIVE_ENABLED", True), \
                patch.object(tutor_route, "create_live_access_token",
                             side_effect=AIProviderError("gemini", "private quota detail", 429)):
            response = self.client.post("/api/tutor/live/session", json={
                "courseId": "course-123", "topicId": "module-1-topic-1",
            })
        self.assertEqual(response.status_code, 429)
        self.assertIn("request limit", response.json()["detail"])
        self.assertNotIn("private quota detail", response.text)
        self.assertNotIn("HTTP 429", response.text)

    def test_live_session_rejects_paused_or_inactive_topics(self):
        self.action("pause")
        with patch.object(tutor_route, "GEMINI_LIVE_ENABLED", True), \
                patch.object(tutor_route, "create_live_access_token") as create_token:
            response = self.client.post("/api/tutor/live/session", json={
                "courseId": "course-123", "topicId": "module-1-topic-1",
            })
        self.assertEqual(response.status_code, 409)
        create_token.assert_not_called()

    def test_live_session_loads_existing_chat_and_voice_messages(self):
        self.action("start")
        self.live_transcript([
            {"role": "user", "text": "Can we review values?"},
            {"role": "assistant", "text": "A value is data. Can you give an example?"},
        ])
        with patch.object(tutor_route, "GEMINI_LIVE_ENABLED", True), \
                patch.object(tutor_route, "create_live_access_token", return_value="one-use-token") as token:
            response = self.client.post("/api/tutor/live/session", json={
                "courseId": "course-123", "topicId": "module-1-topic-1",
            })
        self.assertEqual(response.status_code, 200, response.text)
        instruction = token.call_args.args[0]
        self.assertIn("A value is a piece of data.", instruction)
        self.assertIn("Can we review values?", instruction)

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
                if code == 429:
                    self.assertIn("request limit", response.json()["detail"])
                    self.assertNotIn("HTTP 429", response.json()["detail"])

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
        self.action("message", message="I understand values.")
        self.model.side_effect = AIProviderError("gemini", "unavailable", 504)
        self.assertEqual(self.action("confirm", conceptIndex=0).status_code, 504)
        saved = self.state().json()
        self.assertEqual(saved["conversation"]["concept_index"], 1)
        self.assertIsNone(saved["conversation"]["taught_index"])
        self.assertEqual(saved["topic_status"]["module-1-topic-1"], "in_progress")
        self.assertFalse(saved["can_confirm"])
        self.assertEqual(self.action("confirm", conceptIndex=1).status_code, 409)

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
        self.assertEqual(response.json()["topic_status"]["module-1-topic-2"], "not_started")
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
        self.assertEqual(messages, [{"role": "user", "text": "Explain variables", "reply": None, "channel": "chat"}])
        self.model.assert_called_once()

    def test_reply_schema_error_names_field_without_exposing_content(self):
        def invalid_reply(*args, **kwargs):
            TutorReply.model_validate({**make_reply().model_dump(), "example": {"secret": "PRIVATE_CONTENT"}})
        self.model.side_effect = invalid_reply
        response = self.action("message", message="Help")
        self.assertEqual(response.status_code, 502)
        self.assertIn("couldn't prepare a reliable tutor response", response.json()["detail"])
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
