import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.main import app
from app.services.course_progress import calculate_course_progress, summarize_progress


class ProgressSnapshot:
    def __init__(self, path, data):
        self.id = path.split("/")[-1]
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return self._data


class ProgressDocument:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self):
        return ProgressSnapshot(self.path, self.database.docs.get(self.path))

    def collection(self, name):
        return ProgressCollection(self.database, f"{self.path}/{name}")


class ProgressCollection:
    def __init__(self, database, path):
        self.database = database
        self.path = path

    def get(self):
        prefix = f"{self.path}/"
        return [
            ProgressSnapshot(path, data)
            for path, data in sorted(self.database.docs.items())
            if path.startswith(prefix) and "/" not in path[len(prefix):]
        ]

    def document(self, document_id):
        return ProgressDocument(self.database, f"{self.path}/{document_id}")


class ProgressFirestore:
    def __init__(self, docs=None):
        self.docs = docs or {}

    def collection(self, path):
        return ProgressCollection(self, path)

    def document(self, path):
        return ProgressDocument(self, path)


def simple_syllabus(topic_id="module-1-topic-1"):
    return {"modules": [{"title": "Module", "topics": [{"topic_id": topic_id, "title": "Lesson"}]}]}


class CourseProgressCalculationTests(unittest.TestCase):
    def test_calculates_completion_from_saved_tutor_state(self):
        syllabus = {
            "overview": "Python basics",
            "objective": "Learn Python fundamentals",
            "duration_days": 30,
            "total_study_hours": 3,
            "prerequisites": [],
            "modules": [
                {
                    "module_id": "module-1",
                    "title": "Foundations",
                    "description": "Core concepts",
                    "estimated_hours": 3,
                    "topics": [
                        {"topic_id": "module-1-topic-1", "title": "Values", "description": "Values", "estimated_minutes": 60},
                        {"topic_id": "module-1-topic-2", "title": "Variables", "description": "Variables", "estimated_minutes": 60},
                        {"topic_id": "module-1-topic-3", "title": "Loops", "description": "Loops", "estimated_minutes": 60},
                    ],
                }
            ],
            "resources": [],
        }
        tutor_state = {
            "active_topic_id": "module-1-topic-2",
            "topic_status": {
                "module-1-topic-1": "completed",
                "module-1-topic-2": "in_progress",
                "module-1-topic-3": "not_started",
            },
        }

        result = calculate_course_progress({"courseName": "Python Basics"}, syllabus, tutor_state)

        self.assertEqual(result["totalLessons"], 3)
        self.assertEqual(result["completedLessons"], 1)
        self.assertEqual(result["remainingLessons"], 2)
        self.assertEqual([lesson["status"] for lesson in result["lessons"]], ["completed", "in_progress", "not_started"])
        self.assertEqual(result["completionRate"], 33)
        self.assertEqual(result["status"], "in_progress")
        self.assertEqual(result["currentLesson"], "Variables")
        self.assertEqual(result["nextLesson"], "Variables")

    def test_completed_course_has_no_next_lesson(self):
        syllabus = {"modules": [{"topics": [
            {"topic_id": "lesson-1", "title": "First"},
            {"topic_id": "lesson-2", "title": "Last"},
        ]}]}
        result = calculate_course_progress({}, syllabus, {
            "topic_status": {"lesson-1": "completed", "lesson-2": "completed"},
        })

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["completionRate"], 100)
        self.assertIsNone(result["nextLesson"])

    def test_duplicate_or_missing_topic_ids_do_not_inflate_progress(self):
        syllabus = {"modules": [{"topics": [
            {"topic_id": "lesson-1", "title": "First"},
            {"topic_id": "lesson-1", "title": "Duplicate"},
            {"title": "Missing ID"},
            {"topic_id": "lesson-2", "title": "Second"},
        ]}]}
        result = calculate_course_progress({}, syllabus, {
            "topic_status": {"lesson-1": "completed", "lesson-2": "not_started"},
        })

        self.assertEqual(result["totalLessons"], 2)
        self.assertEqual(result["completedLessons"], 1)

    def test_activity_totals_sum_per_course_and_choose_one_source_per_course(self):
        first = calculate_course_progress(
            {"studySessions": 2, "totalMinutesStudied": 30},
            None,
            {"studySessions": 2, "totalMinutesStudied": 30},
        )
        second = calculate_course_progress(
            {}, None, {"study_session_count": 3, "total_study_minutes": 45},
        )
        third = calculate_course_progress({}, None, {})

        summary = summarize_progress([first, second, third])

        self.assertEqual(summary["lastStudyActivity"]["studySessions"], 5)
        self.assertEqual(summary["lastStudyActivity"]["totalMinutesStudied"], 75)
        self.assertIsNone(third["studySessions"])
        self.assertIsNone(third["totalMinutesStudied"])

    def test_missing_activity_and_empty_courses_remain_unavailable(self):
        course = calculate_course_progress({}, None, {})

        self.assertIsNone(course["studySessions"])
        self.assertIsNone(course["totalMinutesStudied"])
        self.assertIsNone(summarize_progress([course])["lastStudyActivity"])
        self.assertEqual(summarize_progress([])["totalCourses"], 0)
        self.assertIsNone(summarize_progress([])["lastStudyActivity"])

    def test_three_percent_is_correct_for_one_completed_of_thirty_saved_topics(self):
        syllabus = {"modules": [{"title": "Module", "topics": [
            {"topic_id": f"topic-{index}", "title": f"Topic {index}"} for index in range(30)
        ]}]}
        course = calculate_course_progress({}, syllabus, {"topic_status": {"topic-0": "completed"}})
        summary = summarize_progress([course])

        self.assertEqual(course["completionRate"], 3)
        self.assertEqual(course["remainingLessons"], 29)
        self.assertEqual(summary["overallProgress"], 3.33)


class ProgressRouteTests(unittest.TestCase):
    def setUp(self):
        self.database = ProgressFirestore({
            "users/learner-a/learningGoals/pre-syllabus": {
                "courseName": "New course", "goalText": "Explore a subject",
            },
            "users/learner-a/learningGoals/shared-course": {
                "courseName": "Original goal title", "goalText": "Learn fundamentals",
            },
            "users/learner-a/courses/shared-course": {
                "courseName": "Saved course title", "syllabusStatus": "ready", "syllabusVersion": 1,
            },
            "users/learner-a/courses/shared-course/syllabus/v1": simple_syllabus(),
            "users/learner-a/courses/shared-course/tutor/state": {
                "topic_status": {"module-1-topic-1": "completed"},
            },
            "users/learner-a/courses/deleted-course": {
                "courseName": "Deleted Python course",
                "sourceLearningGoalId": "deleted-course",
                "syllabusStatus": "ready",
                "syllabusVersion": 1,
            },
            "users/learner-a/courses/deleted-course/syllabus/v1": simple_syllabus("deleted-lesson"),
            "users/learner-a/courses/deleted-course/tutor/state": {
                "topic_status": {"deleted-lesson": "completed"},
            },
            "users/learner-b/learningGoals/private-goal": {"courseName": "Private goal"},
            "users/learner-b/courses/private-course": {"courseName": "Private course"},
        })
        app.dependency_overrides[get_current_user] = lambda: {"uid": "learner-a"}
        self.firestore_patch = patch("app.api.routes.progress.get_firestore_client", return_value=self.database)
        self.firestore_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.firestore_patch.stop()
        app.dependency_overrides.clear()

    def test_lists_goal_only_course_deduplicates_and_isolates_user_data(self):
        response = self.client.get("/api/progress/summary")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["totalCourses"], 2)
        courses = {course["courseId"]: course for course in payload["courses"]}
        self.assertEqual(set(courses), {"pre-syllabus", "shared-course"})
        self.assertEqual(courses["pre-syllabus"]["syllabusStatus"], "not_generated")
        self.assertEqual(courses["pre-syllabus"]["status"], "not_started")
        self.assertEqual(courses["pre-syllabus"]["totalLessons"], 0)
        self.assertEqual(courses["shared-course"]["title"], "Saved course title")
        self.assertEqual(courses["shared-course"]["completedLessons"], 1)
        self.assertEqual(payload["overallProgress"], 100.0)
        self.assertEqual(payload["courses"][1]["lessons"][0]["status"], "completed")
        self.assertEqual(payload["courses"][1]["remainingLessons"], 0)
        self.assertNotIn("practiceActivity", payload)
        self.assertNotIn("deleted-course", courses)

    def test_deleted_linked_course_is_excluded_without_changing_source_data(self):
        deleted_course = self.database.docs["users/learner-a/courses/deleted-course"]

        response = self.client.get("/api/progress/summary")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["totalCourses"], 2)
        self.assertEqual(response.json()["completedCourses"], 1)
        self.assertNotIn("Deleted Python course", str(response.json()))
        self.assertEqual(self.database.docs["users/learner-a/courses/deleted-course"], deleted_course)
        self.assertIn("users/learner-a/courses/deleted-course/syllabus/v1", self.database.docs)

    def test_empty_user_course_sources_return_empty_summary(self):
        self.database.docs.clear()

        response = self.client.get("/api/progress/summary")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["totalCourses"], 0)
        self.assertEqual(response.json()["courses"], [])
        self.assertIsNone(response.json()["lastStudyActivity"])
        self.assertNotIn("practiceActivity", response.json())

    def test_route_returns_only_authenticated_users_courses(self):
        class FakeDoc:
            def __init__(self, path, data=None):
                self.path = path
                self.id = path.split("/")[-1]
                self._data = data or {}
                self.exists = data is not None

            def to_dict(self):
                return self._data

            def get(self):
                return self

            def collection(self, subcollection_name):
                if subcollection_name == "syllabus":
                    return FakeCollection({"v1": self._data.get("_syllabus", {})}, root=self)
                if subcollection_name == "tutor":
                    return FakeCollection({
                        "state": self._data.get("_tutor", {}),
                    }, root=self)
                return FakeCollection({}, root=self)

        class FakeCollection:
            def __init__(self, docs, root=None):
                self._docs = docs
                self.root = root

            def get(self):
                if self.root is not None and self.root.path.startswith("users/authenticated-user/courses/course-1"):
                    return [FakeDoc("users/authenticated-user/courses/course-1", self.root._data)]
                return [FakeDoc(doc_id, self._docs[doc_id]) for doc_id in sorted(self._docs)]

            def document(self, document_id):
                if document_id in self._docs:
                    return FakeDoc(f"{self.root.path if self.root else ''}/{document_id}", self._docs[document_id])
                base_path = self.root.path if self.root else ""
                if self.root is not None and "syllabus" in base_path:
                    return FakeDoc(f"{base_path}/{document_id}", self._docs.get(document_id))
                return FakeDoc(f"{base_path}/{document_id}", None)

        class FakeDatabase:
            def __init__(self):
                self.docs = {
                    "users/authenticated-user/courses/course-1": {
                        "courseName": "Python Basics",
                        "syllabusStatus": "ready",
                        "syllabusVersion": 1,
                        "_syllabus": {
                            "overview": "Python basics",
                            "objective": "Learn Python fundamentals",
                            "duration_days": 30,
                            "total_study_hours": 3,
                            "prerequisites": [],
                            "modules": [{
                                "module_id": "module-1",
                                "title": "Foundations",
                                "description": "Core concepts",
                                "estimated_hours": 3,
                                "topics": [
                                    {"topic_id": "module-1-topic-1", "title": "Values", "description": "Values", "estimated_minutes": 60},
                                    {"topic_id": "module-1-topic-2", "title": "Variables", "description": "Variables", "estimated_minutes": 60},
                                    {"topic_id": "module-1-topic-3", "title": "Loops", "description": "Loops", "estimated_minutes": 60},
                                ],
                            }],
                            "resources": [],
                        },
                        "_tutor": {"active_topic_id": "module-1-topic-2", "topic_status": {"module-1-topic-1": "completed", "module-1-topic-2": "in_progress", "module-1-topic-3": "not_started"}},
                    },
                    "users/authenticated-user/courses/course-1/syllabus/v1": {
                        "overview": "Python basics",
                        "objective": "Learn Python fundamentals",
                        "duration_days": 30,
                        "total_study_hours": 3,
                        "prerequisites": [],
                        "modules": [
                            {
                                "module_id": "module-1",
                                "title": "Foundations",
                                "description": "Core concepts",
                                "estimated_hours": 3,
                                "topics": [
                                    {"topic_id": "module-1-topic-1", "title": "Values", "description": "Values", "estimated_minutes": 60},
                                    {"topic_id": "module-1-topic-2", "title": "Variables", "description": "Variables", "estimated_minutes": 60},
                                    {"topic_id": "module-1-topic-3", "title": "Loops", "description": "Loops", "estimated_minutes": 60},
                                ],
                            }
                        ],
                        "resources": [],
                    },
                    "users/authenticated-user/courses/course-1/tutor/state": {
                        "active_topic_id": "module-1-topic-2",
                        "topic_status": {"module-1-topic-1": "completed", "module-1-topic-2": "in_progress", "module-1-topic-3": "not_started"},
                    },
                    "users/other-user/courses/course-999": {
                        "courseName": "Hidden course",
                        "syllabusStatus": "ready",
                        "syllabusVersion": 1,
                    },
                    "users/other-user/courses/course-999/syllabus/v1": {
                        "overview": "Hidden",
                        "objective": "Hidden",
                        "duration_days": 30,
                        "total_study_hours": 1,
                        "prerequisites": [],
                        "modules": [
                            {
                                "module_id": "module-1",
                                "title": "Hidden module",
                                "description": "Hidden module",
                                "estimated_hours": 1,
                                "topics": [{"topic_id": "module-1-topic-1", "title": "Secret", "description": "Secret", "estimated_minutes": 60}],
                            }
                        ],
                        "resources": [],
                    },
                    "users/other-user/courses/course-999/tutor/state": {
                        "active_topic_id": "module-1-topic-1",
                        "topic_status": {"module-1-topic-1": "completed"},
                    },
                }

            def collection(self, path):
                if path.endswith("/courses"):
                    return FakeCollection({
                        key.split("/")[-1]: self.docs[key]
                        for key in self.docs
                        if key.startswith("users/authenticated-user/courses/") and key.count("/") == 3
                    })
                return FakeCollection({})

            def document(self, path):
                if path in self.docs:
                    return FakeDoc(path, self.docs[path])
                return FakeDoc(path, None)

        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        with patch("app.api.routes.progress.get_firestore_client", return_value=FakeDatabase()):
            client = TestClient(app)
            response = client.get("/api/progress/summary")

        app.dependency_overrides.clear()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["totalCourses"], 1)
        self.assertEqual(payload["completedCourses"], 0)
        self.assertEqual(payload["coursesInProgress"], 1)
        self.assertEqual(payload["courses"][0]["courseId"], "course-1")
        self.assertEqual(payload["courses"][0]["currentLesson"], "Variables")
