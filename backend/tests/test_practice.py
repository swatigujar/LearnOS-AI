import unittest
import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.schemas.practice import InterviewCategoryAvailability, PracticeTopic
from app.main import app
from app.services import practice
from app.services.ai_provider import AIProviderError
from tests.test_syllabus import make_syllabus


class FakePracticeReference:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self):
        value = deepcopy(self.database.docs.get(self.path))
        return SimpleNamespace(exists=value is not None, to_dict=lambda: value)

    def collection(self, name):
        return FakePracticeCollection(self.database, f"{self.path}/{name}")

    def set(self, data, merge=False):
        if merge:
            current = deepcopy(self.database.docs.get(self.path, {}))
            current.update(deepcopy(data))
            self.database.docs[self.path] = current
        else:
            self.database.docs[self.path] = deepcopy(data)


class FakePracticeCollection:
    def __init__(self, database, path):
        self.database = database
        self.path = path

    def document(self, document_id):
        return FakePracticeReference(self.database, f"{self.path}/{document_id}")

    def get(self):
        prefix = self.path + "/"
        snapshots = []
        for path, value in self.database.docs.items():
            rest = path[len(prefix):] if path.startswith(prefix) else ""
            if rest and "/" not in rest:
                snapshots.append(SimpleNamespace(id=rest, to_dict=lambda value=deepcopy(value): value))
        return snapshots


class FakePracticeFirestore:
    def __init__(self):
        syllabus = make_syllabus().model_dump(mode="json")
        syllabus["modules"][0]["topics"][0].update({"title": "Variables", "description": "Declare, assign, and reassign Java variables."})
        self.docs = {
            "users/learner-a/learningGoals/java-goal": {"courseName": "Java Fundamentals"},
            "users/learner-a/courses/java-goal": {"sourceLearningGoalId": "java-goal", "syllabusStatus": "ready", "syllabusVersion": 1},
            "users/learner-a/courses/java-goal/syllabus/v1": syllabus,
            "users/learner-a/courses/deleted-goal": {"sourceLearningGoalId": "deleted-goal", "syllabusStatus": "ready", "syllabusVersion": 1},
            "users/learner-a/courses/deleted-goal/syllabus/v1": syllabus,
            "users/learner-b/learningGoals/private-goal": {"courseName": "Java Fundamentals"},
            "users/learner-b/courses/private-goal": {"sourceLearningGoalId": "private-goal", "syllabusStatus": "ready", "syllabusVersion": 1},
            "users/learner-b/courses/private-goal/syllabus/v1": syllabus,
        }

    def collection(self, path):
        return FakePracticeCollection(self, path)

    def document(self, path):
        return FakePracticeReference(self, path)


class PracticeEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.database = FakePracticeFirestore()
        self.uid = "learner-a"
        self.dependency = lambda: {"uid": self.uid}
        app.dependency_overrides[get_current_user] = self.dependency
        self.firestore_patch = patch.object(practice, "get_firestore_client", return_value=self.database)
        self.firestore_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.firestore_patch.stop()
        app.dependency_overrides.clear()

    def test_difficulty_count_schemas_accept_missing_or_partial_legacy_maps(self):
        topic = PracticeTopic.model_validate({
            "topicId": "topic-1", "title": "Variables", "moduleTitle": "Java basics",
            "courseId": "java-goal", "courseTitle": "Java Fundamentals", "syllabusVersion": 1,
            "difficulties": ["Easy"], "questionCount": 2,
        })
        self.assertEqual(topic.questionCounts, {})
        category = InterviewCategoryAvailability.model_validate({
            "category": "Java", "difficulties": ["Easy"], "questionCount": 2,
            "questionCounts": {"Easy": 2},
        })
        self.assertEqual(category.questionCounts, {"Easy": 2})

    def test_course_selection_lists_only_active_goals_with_supported_saved_topics(self):
        response = self.client.get("/api/practice/courses")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["courseId"] for item in response.json()["topics"]], ["java-goal"])
        self.assertEqual(response.json()["topics"][0]["title"], "Variables")
        self.assertEqual(response.json()["topics"][0]["difficulties"], ["Easy", "Medium", "Hard"])
        self.assertEqual(response.json()["topics"][0]["questionCount"], 5)
        self.assertEqual(response.json()["topics"][0]["questionCounts"], {"Easy": 4, "Medium": 1, "Hard": 0})

    def test_topic_discovery_does_not_require_a_hardcoded_course_name(self):
        syllabus = make_syllabus().model_dump(mode="json")
        syllabus["modules"][0]["topics"][0].update({"title": "Linear equations", "description": "Solve equations using inverse operations."})
        self.database.docs.update({
            "users/learner-a/learningGoals/algebra-goal": {"courseName": "Applied Algebra"},
            "users/learner-a/courses/algebra-goal": {"sourceLearningGoalId": "algebra-goal", "syllabusStatus": "ready", "syllabusVersion": 1},
            "users/learner-a/courses/algebra-goal/syllabus/v1": syllabus,
        })
        response = self.client.get("/api/practice/courses")
        self.assertEqual(response.status_code, 200)
        topics = response.json()["topics"]
        algebra = next(item for item in topics if item["courseId"] == "algebra-goal")
        self.assertEqual(algebra["title"], "Linear equations")
        self.assertEqual(algebra["questionCount"], 0)

    def test_concept_topic_requires_matching_saved_syllabus_context(self):
        syllabus_path = "users/learner-a/courses/java-goal/syllabus/v1"
        self.database.docs[syllabus_path]["modules"][0]["topics"][0]["title"] = "Language standards"
        self.database.docs[syllabus_path]["modules"][0]["topics"][0]["description"] = "A history of programming language standards."
        self.database.docs[syllabus_path]["modules"][0]["title"] = "Language history"
        response = self.client.get("/api/practice/courses")
        self.assertEqual(response.status_code, 200)
        topic = response.json()["topics"][0]
        self.assertEqual(topic["questionCount"], 0)
        self.assertEqual(topic["questionCounts"], {"Easy": 0, "Medium": 0, "Hard": 0})

    def test_static_questions_do_not_expose_keys_and_submit_calculates_and_saves_attempt(self):
        questions = self.client.get("/api/practice/questions", params={
            "courseId": "java-goal", "topicId": "module-1-topic-1", "syllabusVersion": 1, "difficulty": "Easy",
        })
        self.assertEqual(questions.status_code, 200)
        self.assertEqual(len(questions.json()["questions"]), 4)
        self.assertEqual(len(questions.json()["questions"]), self.client.get("/api/practice/courses").json()["topics"][0]["questionCounts"]["Easy"])
        self.assertNotIn("answer", questions.text)
        response = self.client.post("/api/practice/submit", json={
            "courseId": "java-goal", "topicId": "module-1-topic-1", "syllabusVersion": 1,
            "difficulty": "Easy", "answers": {"q1": 1, "q2": 0},
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()["total"], response.json()["correct"], response.json()["incorrect"], response.json()["unanswered"], response.json()["percentage"]), (4, 1, 1, 2, 25))
        attempt_path = f"users/learner-a/practiceAttempts/{response.json()['attemptId']}"
        self.assertIn(attempt_path, self.database.docs)
        self.assertEqual(response.json()["questions"][0]["explanation"], "A Java variable declaration gives the type first, then the variable name, followed by an assignment when needed.")

    def test_deleted_course_is_rejected_even_if_orphaned_syllabus_remains(self):
        response = self.client.post("/api/practice/submit", json={
            "courseId": "deleted-goal", "topicId": "module-1-topic-1", "syllabusVersion": 1,
            "difficulty": "Easy", "answers": {},
        })
        self.assertEqual(response.status_code, 404)

    def test_attempt_history_is_scoped_to_authenticated_user(self):
        self.database.docs["users/learner-a/practiceAttempts/a1"] = {
            "courseId": "java-goal", "courseTitle": "Java Fundamentals", "topicId": "topic",
            "topicTitle": "Variables", "difficulty": "Easy", "total": 4, "correct": 3,
            "incorrect": 1, "percentage": 75,
        }
        self.database.docs["users/learner-b/practiceAttempts/b1"] = {
            "courseId": "private-goal", "courseTitle": "Private", "topicId": "topic",
            "topicTitle": "Private topic", "difficulty": "Easy", "total": 4, "correct": 4,
            "incorrect": 0, "percentage": 100,
        }
        response = self.client.get("/api/practice/attempts")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["attemptId"] for item in response.json()["attempts"]], ["a1"])

    def test_empty_question_bank_returns_empty_questions(self):
        with patch.object(practice, "_BANK", []):
            response = self.client.get("/api/practice/questions", params={
                "courseId": "java-goal", "topicId": "module-1-topic-1", "syllabusVersion": 1, "difficulty": "Easy",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"questions": []})

    def test_interview_category_and_difficulty_catalog_only_advertises_available_questions(self):
        catalog = self.client.get("/api/practice/interview/catalog")
        self.assertEqual(catalog.status_code, 200)
        self.assertEqual([item["category"] for item in catalog.json()["categories"]], [
            "Manual Testing", "Playwright", "API Testing", "SQL", "JavaScript/TypeScript", "Java", "DSA", "SDET",
        ])
        playwright = next(item for item in catalog.json()["categories"] if item["category"] == "Playwright")
        self.assertEqual(playwright["difficulties"], ["Medium"])
        self.assertEqual(playwright["questionCount"], 2)
        self.assertEqual(playwright["questionCounts"], {"Easy": 0, "Medium": 2, "Hard": 0})
        response = self.client.get("/api/practice/interview/questions", params={"category": "Playwright", "difficulty": "Easy"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"questions": []})

    def test_explicit_concept_generation_is_syllabus_grounded_cached_and_keeps_keys_private(self):
        generated = {"questions": [
            {"kind": "mcq", "prompt": "In Java, what is a variable declaration?", "options": ["A typed name for a value", "A package", "A loop", "A class"], "answerIndex": 0, "sampleAnswer": "A typed name for a value", "rubric": [], "explanation": "A declaration gives a variable its name and type."},
            {"kind": "short_answer", "prompt": "How do you assign a value to a Java variable?", "options": [], "answerIndex": None, "sampleAnswer": "Use the variable name, equals sign, and compatible value.", "rubric": ["Names the variable", "Uses assignment"], "explanation": "Assignment stores a value in the declared variable."},
        ]}
        provider = Mock()
        provider.generate_structured.return_value = SimpleNamespace(text=json.dumps(generated))
        payload = {"mode": "concept", "courseId": "java-goal", "topicId": "module-1-topic-1",
            "syllabusVersion": 1, "difficulty": "Easy", "questionCount": 2, "questionFormat": "mixed"}
        with patch.object(practice, "get_ai_provider", return_value=provider):
            response = self.client.post("/api/practice/generate", json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["questionCount"], 2)
            self.assertEqual(response.json()["source"], "generated")
            self.assertEqual(len(response.json()["sessionId"]), 32)
            self.assertIn("grounded in your selected practice context", response.json()["adaptationNote"])
            self.assertNotIn("answerIndex", response.text)
            self.assertIn("Declare, assign, and reassign Java variables", provider.generate_structured.call_args.args[0])
            set_id = response.json()["setId"]
            cached = self.client.post("/api/practice/generate", json=payload)
            self.assertEqual(cached.status_code, 200)
            self.assertEqual(cached.json()["source"], "cached")
            self.assertEqual(cached.json()["setId"], set_id)
            self.assertNotEqual(cached.json()["sessionId"], response.json()["sessionId"])
            retry_session = self.client.post("/api/practice/generate", json=payload).json()
            submitted = self.client.post("/api/practice/generated-submit", json={
                "setId": set_id, "sessionId": cached.json()["sessionId"],
                "answers": {"q1": 0, "q2": "Use the variable name and assign a compatible value."},
            })
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual((submitted.json()["scoreable"], submitted.json()["correct"], submitted.json()["percentage"]), (1, 1, 100))
        self.assertEqual(submitted.json()["questions"][1]["correct"], None)
        duplicate = self.client.post("/api/practice/generated-submit", json={
            "setId": set_id, "sessionId": cached.json()["sessionId"], "answers": {"q1": 3},
        })
        self.assertEqual(duplicate.json()["attemptId"], submitted.json()["attemptId"])
        self.assertEqual(duplicate.json()["correct"], 1)
        retry_submit = self.client.post("/api/practice/generated-submit", json={
            "setId": set_id, "sessionId": retry_session["sessionId"], "answers": {"q1": 3},
        })
        self.assertEqual(retry_submit.status_code, 200, retry_submit.text)
        self.assertNotEqual(retry_submit.json()["attemptId"], submitted.json()["attemptId"])
        self.assertEqual(provider.generate_structured.call_count, 1)
        self.uid = "learner-b"
        denied = self.client.post("/api/practice/generated-submit", json={"setId": set_id,
            "sessionId": cached.json()["sessionId"], "answers": {}})
        self.assertEqual(denied.status_code, 404)

    def test_generated_interview_uses_selected_skill_and_target_role(self):
        generated = {"questions": [{
            "kind": "mcq", "prompt": "For Playwright automation, which locator should an SDET prefer for a Save button?",
            "options": ["An accessible role and name", "A positional selector", "A fixed wait", "A CSS color"],
            "answerIndex": 0, "sampleAnswer": "An accessible role and name",
            "explanation": "Playwright role locators reflect accessible user-facing semantics.",
        }]}
        provider = Mock()
        provider.generate_structured.return_value = SimpleNamespace(text=json.dumps(generated))
        with patch.object(practice, "get_ai_provider", return_value=provider):
            response = self.client.post("/api/practice/generate", json={
                "mode": "interview", "category": "Playwright automation", "targetRole": "SDET",
                "difficulty": "Medium", "questionCount": 1, "questionFormat": "mcq",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("answerIndex", response.text)
        prompt = provider.generate_structured.call_args.args[0]
        self.assertIn("Playwright automation", prompt)
        self.assertIn("SDET", prompt)
        submitted = self.client.post("/api/practice/generated-submit", json={
            "setId": response.json()["setId"], "sessionId": response.json()["sessionId"], "answers": {"q1": 0},
        })
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(submitted.json()["mode"], "interview")
        saved = self.database.docs[f"users/learner-a/practiceAttempts/{submitted.json()['attemptId']}"]
        self.assertEqual(saved["category"], "Playwright automation")

    def test_scenario_generation_uses_saved_course_topic_and_persists_private_self_review(self):
        syllabus = make_syllabus().model_dump(mode="json")
        syllabus["modules"][0]["topics"][0].update({
            "title": "Linear equations", "description": "Solve linear equations using inverse operations and check each solution by substitution.",
        })
        self.database.docs.update({
            "users/learner-a/learningGoals/algebra-goal": {"courseName": "Applied Algebra"},
            "users/learner-a/courses/algebra-goal": {"sourceLearningGoalId": "algebra-goal", "syllabusStatus": "ready", "syllabusVersion": 1},
            "users/learner-a/courses/algebra-goal/syllabus/v1": syllabus,
        })
        generated = {"questions": [{
            "kind": "short_answer", "prompt": "A learner gets a different answer after solving an equation. How would you investigate?",
            "options": [], "answerIndex": None, "sampleAnswer": "Apply inverse operations one step at a time, then substitute the proposed value into the original equation.",
            "rubric": ["Checks each inverse operation", "Verifies by substitution"],
            "explanation": "Substitution in the original equation checks whether the proposed solution satisfies the starting relation.",
            "scenarioTitle": "A mismatch while solving", "scenarioContext": "Two worked solutions differ after an inverse operation is applied to both sides.",
            "scenarioTask": "Identify a careful investigation sequence and explain how you would verify the final value.",
            "suggestedNextSteps": ["Rework the operation on both sides", "Substitute into the original equation"],
        }]}
        provider = Mock()
        provider.generate_structured.return_value = SimpleNamespace(text=json.dumps(generated))
        payload = {"mode": "scenario", "courseId": "algebra-goal", "topicId": "module-1-topic-1",
            "syllabusVersion": 1, "difficulty": "Medium", "questionCount": 1, "questionFormat": "short_answer"}
        with patch.object(practice, "get_ai_provider", return_value=provider):
            created = self.client.post("/api/practice/generate", json=payload)
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(created.json()["mode"], "scenario")
            self.assertEqual(created.json()["questions"][0]["scenarioTitle"], "A mismatch while solving")
            self.assertNotIn("sampleAnswer", created.text)
            prompt = provider.generate_structured.call_args.args[0]
            self.assertIn("Applied Algebra", prompt)
            self.assertIn("Linear equations", prompt)
            submitted = self.client.post("/api/practice/generated-submit", json={
                "setId": created.json()["setId"], "sessionId": created.json()["sessionId"],
                "answers": {"q1": "I would check the inverse operation and substitute the answer."},
            })
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(submitted.json()["mode"], "scenario")
        self.assertIsNone(submitted.json()["percentage"])
        self.assertIsNone(submitted.json()["questions"][0]["correct"])
        self.assertEqual(submitted.json()["questions"][0]["suggestedNextSteps"], generated["questions"][0]["suggestedNextSteps"])
        path = f"users/learner-a/practiceAttempts/{submitted.json()['attemptId']}"
        self.assertIn(path, self.database.docs)
        self.uid = "learner-b"
        denied = self.client.get(f"/api/practice/attempts/{submitted.json()['attemptId']}")
        self.assertEqual(denied.status_code, 404)
        self.uid = "learner-a"
        deleted = self.client.post("/api/practice/generate", json={**payload, "courseId": "deleted-goal"})
        self.assertEqual(deleted.status_code, 404)

    def test_generated_practice_rejects_malformed_provider_output_without_fallback(self):
        provider = SimpleNamespace(generate_structured=lambda *args, **kwargs: SimpleNamespace(text='{"questions": []}'))
        with patch.object(practice, "get_ai_provider", return_value=provider):
            response = self.client.post("/api/practice/generate", json={
                "mode": "concept", "courseId": "java-goal", "topicId": "module-1-topic-1",
                "syllabusVersion": 1, "difficulty": "Easy", "questionCount": 2,
            })
        self.assertEqual(response.status_code, 502)
        self.assertIn("did not pass validation", response.json()["detail"])

    def test_provider_quota_and_timeout_errors_are_sanitized_without_retry(self):
        payload = {"mode": "concept", "courseId": "java-goal", "topicId": "module-1-topic-1",
            "syllabusVersion": 1, "difficulty": "Easy", "questionCount": 2}
        for status, expected in ((429, 429), (504, 504)):
            provider = Mock()
            provider.generate_structured.side_effect = AIProviderError("gemini", "private provider details", status)
            with self.subTest(status=status), patch.object(practice, "get_ai_provider", return_value=provider):
                response = self.client.post("/api/practice/generate", json=payload)
                self.assertEqual(response.status_code, expected)
                self.assertNotIn("private provider details", response.text)
                provider.generate_structured.assert_called_once()

    def test_interview_mcq_check_and_descriptive_review_are_server_held_until_attempted(self):
        bank = self.client.get("/api/practice/interview/questions", params={"category": "SQL", "difficulty": "Easy"})
        self.assertEqual(bank.status_code, 200)
        self.assertNotIn("expectedAnswer", bank.text)
        self.assertNotIn("explanation", bank.text)
        checked = self.client.post("/api/practice/interview/check", json={
            "category": "SQL", "difficulty": "Easy", "questionId": "sql-join", "answer": 0,
        })
        self.assertEqual(checked.json()["correct"], True)
        self.assertIn("INNER JOIN", checked.json()["expectedAnswer"])
        descriptive = self.client.post("/api/practice/interview/check", json={
            "category": "Playwright", "difficulty": "Medium", "questionId": "playwright-await",
            "answer": "I would inspect the trace and use a state based assertion.",
        })
        self.assertIsNone(descriptive.json()["correct"])
        self.assertIn("Playwright's auto-waiting", descriptive.json()["expectedAnswer"])

    def test_interview_attempt_scores_mcq_only_saves_revision_marks_and_is_user_scoped(self):
        response = self.client.post("/api/practice/interview/submit", json={
            "category": "Manual Testing", "difficulty": "Easy",
            "answers": {"manual-test-risk": 1}, "revisionQuestionIds": ["manual-test-risk"],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()["correct"], response.json()["incorrect"], response.json()["unanswered"], response.json()["percentage"]), (0, 1, 1, 0))
        self.assertTrue(response.json()["questions"][0]["forRevision"])
        attempt_id = response.json()["attemptId"]
        saved = self.database.docs[f"users/learner-a/practiceAttempts/{attempt_id}"]
        self.assertEqual(saved["mode"], "interview")
        history = self.client.get(f"/api/practice/attempts/{attempt_id}")
        self.assertEqual(history.status_code, 200)
        self.assertTrue(history.json()["questions"][0]["forRevision"])
        self.uid = "learner-b"
        denied = self.client.get(f"/api/practice/attempts/{attempt_id}")
        self.assertEqual(denied.status_code, 404)

    def test_interview_rejects_answer_values_outside_the_selected_questions(self):
        wrong_option_type = self.client.post("/api/practice/interview/submit", json={
            "category": "SQL", "difficulty": "Easy", "answers": {"sql-join": "0"},
        })
        self.assertEqual(wrong_option_type.status_code, 422)
        wrong_question = self.client.post("/api/practice/interview/submit", json={
            "category": "SQL", "difficulty": "Easy", "answers": {"java-equals": 0},
        })
        self.assertEqual(wrong_question.status_code, 422)

    def test_interview_empty_bank_returns_empty_catalog_and_unknown_question_errors(self):
        with patch.object(practice, "_INTERVIEW_BANK", []):
            catalog = self.client.get("/api/practice/interview/catalog")
            questions = self.client.get("/api/practice/interview/questions", params={"category": "Java", "difficulty": "Easy"})
        self.assertEqual(catalog.json(), {"categories": []})
        self.assertEqual(questions.json(), {"questions": []})
        missing = self.client.post("/api/practice/interview/check", json={
            "category": "Java", "difficulty": "Easy", "questionId": "missing", "answer": 0,
        })
        self.assertEqual(missing.status_code, 404)

    def test_scenarios_keep_reference_private_until_submission_and_save_self_review(self):
        catalog = self.client.get("/api/practice/scenarios")
        self.assertEqual(catalog.status_code, 200)
        scenarios = catalog.json()["scenarios"]
        self.assertEqual(len(scenarios), 7)
        self.assertTrue(all("checklist" in item for item in scenarios))
        self.assertNotIn("referenceAnswer", catalog.text)
        item = next(item for item in scenarios if item["scenarioId"] == "timezone-weekly-progress")
        response = self.client.post("/api/practice/scenarios/submit", json={
            "scenarioId": item["scenarioId"], "response": "Use local week boundaries converted to UTC.",
            "checklistIds": ["utc", "zone"], "forRevision": True,
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("half-open interval", response.json()["referenceAnswer"])
        self.assertEqual(sum(1 for line in response.json()["checklist"] if line["selected"]), 2)
        self.assertEqual(len(response.json()["suggestedNextSteps"]), 2)
        saved = self.database.docs[f"users/learner-a/practiceAttempts/{response.json()['attemptId']}"]
        self.assertEqual(saved["mode"], "scenario")
        self.assertTrue(saved["forRevision"])
        detail = self.client.get(f"/api/practice/attempts/{response.json()['attemptId']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["response"], "Use local week boundaries converted to UTC.")


if __name__ == "__main__":
    unittest.main()
