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
from app.services import mock_test as mock_service
from tests.test_syllabus import FakeFirestore, make_syllabus


def make_question_set(count=10, tag=""):
    return {
        "questions": [
            {"prompt": f"Which statement best describes concept {index}{tag} in this topic?",
             "options": [f"Correct concept {index}", f"Distractor A {index}", f"Distractor B {index}", f"Distractor C {index}"],
             "answer_index": 0,
             "explanation": f"Concept {index} follows the saved topic description."}
            for index in range(1, count + 1)
        ]
    }


def make_verification(count=12, wrong=(), ambiguous=()):
    return {"verdicts": [
        {"question_number": number, "correct_index": 1 if number in wrong else 0, "unambiguous": number not in ambiguous}
        for number in range(1, count + 1)
    ]}


class MockTestSchemaTests(unittest.TestCase):
    def test_accepts_legacy_six_and_new_ten_question_banks(self):
        valid = GeneratedMockQuestionSet.model_validate(make_question_set())
        self.assertEqual(len(valid.questions), 10)
        self.assertTrue(all(len(question.options) == 4 and 0 <= question.answer_index <= 3 for question in valid.questions))

        legacy = make_question_set()
        legacy["questions"] = legacy["questions"][:6]
        self.assertEqual(len(GeneratedMockQuestionSet.model_validate(legacy).questions), 6)

        duplicate = make_question_set()
        duplicate["questions"][0]["options"][1] = duplicate["questions"][0]["options"][0]
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(duplicate)

        short = make_question_set()
        short["questions"] = short["questions"][:5]
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(short)

        too_long = make_question_set()
        too_long["questions"].append(dict(too_long["questions"][0], prompt="An eleventh distinct question prompt?"))
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(too_long)

        unsupported_count = make_question_set()
        unsupported_count["questions"] = unsupported_count["questions"][:7]
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(unsupported_count)

        invalid_answer = make_question_set()
        invalid_answer["questions"][0]["answer_index"] = 4
        with self.assertRaises(ValidationError):
            GeneratedMockQuestionSet.model_validate(invalid_answer)



ATTEMPT_1 = "00000000-0000-4000-8000-000000000001"
ATTEMPT_2 = "00000000-0000-4000-8000-000000000002"


class MockTestEndpointTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeFirestore()
        self.database.docs[self.database.course_path].update(syllabusStatus="ready", syllabusVersion=1, course_name="Applied Algebra")
        self.database.docs[self.database.course_path + "/syllabus/v1"] = make_syllabus().model_dump(mode="json")
        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        patches = [
            patch("app.services.mock_test.get_firestore_client", return_value=self.database),
            patch("app.services.mock_test._recent_attempt_docs", side_effect=self.recent_attempts),
        ]
        self.provider = Mock()
        self.queue_generation()
        patches.append(patch("app.services.mock_test.get_ai_provider", return_value=self.provider))
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(app.dependency_overrides.clear)

    def queue_generation(self, *rounds):
        rounds = rounds or ((make_question_set(12), make_verification()),)
        effects = []
        for questions, verification in rounds:
            effects.append(Mock(text=json.dumps(questions)))
            effects.append(Mock(text=json.dumps(verification)))
        self.provider.generate_structured.side_effect = effects

    def recent_attempts(self, course_ref, limit):
        prefix = f"{course_ref.path}/mockTestAttempts/"
        docs = [value for key, value in self.database.docs.items() if key.startswith(prefix)]
        return sorted(docs, key=lambda item: item.get("completedAt") or "", reverse=True)[:limit]

    def bank_path(self, attempt_id=ATTEMPT_1):
        return f"{self.database.course_path}/mockQuestionBanks/attempt_{attempt_id}"

    def result_path(self, attempt_id=ATTEMPT_1):
        return f"{self.database.course_path}/mockTestAttempts/{attempt_id}"

    def start(self, attempt_id=ATTEMPT_1, topic_id="module-1-topic-1"):
        return self.client.post("/api/mock-test/start", json={
            "courseId": "course-123", "topicId": topic_id, "syllabusVersion": 1, "attemptId": attempt_id,
        })

    def submit(self, answers, attempt_id=ATTEMPT_1):
        return self.client.post("/api/mock-test/submit", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1,
            "attemptId": attempt_id, "answers": answers,
        })

    def test_each_attempt_generates_a_fresh_verified_bank_without_leaking_answers(self):
        response = self.start()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual((body["status"], body["attemptId"], len(body["questions"])), ("ready", ATTEMPT_1, 10))
        self.assertNotIn("answer_index", response.text)
        self.assertNotIn("explanation", response.text)
        generate, verify = self.provider.generate_structured.call_args_list
        self.assertIn("exactly twelve", generate.args[0])
        self.assertIn("Applied Algebra", generate.args[0])
        self.assertEqual(generate.kwargs["request_id"], ATTEMPT_1)
        self.assertEqual(verify.kwargs["request_id"], f"{ATTEMPT_1}:verify")
        self.assertNotIn("answer_index", verify.args[0])
        self.assertEqual(len(self.database.docs[self.bank_path()]["questions"]), 10)

        self.assertEqual(self.start().json()["status"], "ready")
        self.assertEqual(self.provider.generate_structured.call_count, 2)

        self.queue_generation((make_question_set(12, tag=" second"), make_verification()))
        second = self.start(ATTEMPT_2)
        self.assertEqual(second.json()["status"], "ready")
        self.assertIn("second", second.json()["questions"][0]["prompt"])

    def test_verifier_disagreements_are_dropped_and_too_few_fail(self):
        self.queue_generation((make_question_set(12), make_verification(wrong=(1,), ambiguous=(2,))))
        response = self.start()
        self.assertEqual(response.json()["status"], "ready")
        prompts = [item["prompt"] for item in response.json()["questions"]]
        self.assertFalse(any("concept 1 " in prompt or "concept 2 " in prompt for prompt in prompts))

        self.queue_generation((make_question_set(12), make_verification(wrong=(1, 2, 3))))
        failed = self.start(ATTEMPT_2)
        self.assertEqual(failed.json()["status"], "failed")
        self.assertNotEqual(self.database.docs[self.bank_path(ATTEMPT_2)]["status"], "ready")

    def test_submit_grades_on_server_persists_once_and_lists_history(self):
        self.start()
        submitted = self.submit({"q1": 0, "q2": 1})
        self.assertEqual(submitted.status_code, 200)
        result = submitted.json()
        self.assertEqual((result["total"], result["correct"], result["incorrect"], result["unanswered"], result["percentage"]), (10, 1, 1, 8, 10))
        self.assertEqual((result["attemptId"], result["courseTitle"], result["topicId"]), (ATTEMPT_1, "Applied Algebra", "module-1-topic-1"))
        self.assertTrue(result["topicTitle"] and result["moduleTitle"] and result["completedAt"])
        self.assertEqual(result["questions"][1]["correctIndex"], 0)
        saved = self.database.docs[self.result_path()]
        self.assertEqual((saved["userId"], saved["correct"]), ("authenticated-user", 1))

        again = self.submit({f"q{index}": 0 for index in range(1, 11)})
        self.assertEqual(again.json()["correct"], 1)
        self.assertEqual(again.json()["completedAt"], result["completedAt"])

        history = self.client.get("/api/mock-test/attempts", params={"courseId": "course-123"})
        self.assertEqual(history.status_code, 200)
        self.assertEqual([item["attemptId"] for item in history.json()["attempts"]], [ATTEMPT_1])
        self.assertEqual(self.provider.generate_structured.call_count, 2)

    def test_next_generation_asks_to_avoid_previous_questions(self):
        self.start()
        self.submit({"q1": 0})
        self.queue_generation((make_question_set(12, tag=" new"), make_verification()))
        self.start(ATTEMPT_2)
        prompt = self.provider.generate_structured.call_args_list[-2].args[0]
        self.assertIn("Do not repeat", prompt)
        self.assertIn("concept 1 in this topic", prompt)

    def test_submit_rejects_missing_bank_wrong_ids_and_missing_attempt(self):
        self.assertEqual(self.submit({"q1": 0}).status_code, 409)
        self.start()
        self.assertEqual(self.submit({"q11": 0}).status_code, 422)
        self.assertEqual(self.submit({"q1": 4}).status_code, 422)
        missing = self.client.post("/api/mock-test/submit", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1, "answers": {},
        })
        self.assertEqual(missing.status_code, 422)
        self.assertNotIn(self.result_path(), self.database.docs)

    def test_bank_reads_never_generate(self):
        params = {"courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 1}
        self.assertEqual(self.client.get("/api/mock-test/bank", params=params).json()["status"], "missing")
        self.assertEqual(self.client.get("/api/mock-test/bank", params={**params, "attemptId": ATTEMPT_1}).json()["status"], "missing")
        self.provider.generate_structured.assert_not_called()
        self.start()
        ready = self.client.get("/api/mock-test/bank", params={**params, "attemptId": ATTEMPT_1})
        self.assertEqual((ready.json()["status"], len(ready.json()["questions"])), ("ready", 10))
        self.assertNotIn("answer_index", ready.text)

    def test_usage_budget_rejection_is_persisted_and_does_not_call_gemini(self):
        provider = GeminiProvider()
        with patch("app.services.mock_test.get_ai_provider", return_value=provider), patch(
            "app.services.ai_provider.run_tracked_provider_call",
            side_effect=UsageLimitError("The configured daily Gemini request limit has been reached."),
        ) as guarded_call, patch.object(GeminiProvider, "_client") as client:
            response = self.start()
        self.assertEqual(response.json()["status"], "budget_blocked")
        self.assertEqual(self.database.docs[self.bank_path()]["status"], "budget_blocked")
        guarded_call.assert_called_once()
        client.assert_not_called()

    def test_failed_generation_is_terminal_for_that_attempt(self):
        self.provider.generate_structured.side_effect = [
            AIProviderError("gemini", "provider unavailable", 503),
            Mock(text=json.dumps(make_question_set(12))), Mock(text=json.dumps(make_verification())),
        ]
        self.assertEqual(self.start().json()["status"], "failed")
        self.assertEqual(self.start().json()["status"], "failed")
        self.provider.generate_structured.assert_called_once()
        self.assertEqual(self.start(ATTEMPT_2).json()["status"], "ready")

    def test_late_generation_cannot_overwrite_a_finished_bank(self):
        bank_ref = self.database.document(self.bank_path())
        _, claimed = mock_service._claim_generation(self.database.transaction(), bank_ref, ATTEMPT_1, 1, "module-1-topic-1")
        self.assertTrue(claimed)
        _, claimed_again = mock_service._claim_generation(self.database.transaction(), bank_ref, ATTEMPT_1, 1, "module-1-topic-1")
        self.assertFalse(claimed_again)
        self.assertTrue(mock_service._finish_generation(self.database.transaction(), bank_ref, ATTEMPT_1, {"status": "failed"}))
        self.assertFalse(mock_service._finish_generation(self.database.transaction(), bank_ref, ATTEMPT_1, {"status": "ready"}))

    def test_unrelated_course_and_stale_syllabus_are_rejected_without_provider_call(self):
        other = self.client.post("/api/mock-test/start", json={
            "courseId": "someone-elses-course", "topicId": "module-1-topic-1", "syllabusVersion": 1, "attemptId": ATTEMPT_1,
        })
        self.assertEqual(other.status_code, 404)
        self.assertEqual(self.client.get("/api/mock-test/attempts", params={"courseId": "someone-elses-course"}).status_code, 404)
        stale = self.client.post("/api/mock-test/start", json={
            "courseId": "course-123", "topicId": "module-1-topic-1", "syllabusVersion": 2, "attemptId": ATTEMPT_1,
        })
        self.assertEqual(stale.status_code, 409)
        self.provider.generate_structured.assert_not_called()


if __name__ == "__main__":
    unittest.main()
