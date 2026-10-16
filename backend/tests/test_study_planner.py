import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from firebase_admin import firestore

from app.api.dependencies import get_current_user
from app.api.routes import study_planner
from app.main import app


class FakeSnapshot:
    def __init__(self, path, data):
        self.id = path.split("/")[-1]
        self._data = deepcopy(data)
        self.exists = data is not None

    def to_dict(self):
        return deepcopy(self._data)


class FakeReference:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self):
        return FakeSnapshot(self.path, self.database.docs.get(self.path))

    def collection(self, name):
        return FakeCollection(self.database, f"{self.path}/{name}")

    def _replace_special_values(self, values):
        result = {}
        for key, value in values.items():
            if value is firestore.SERVER_TIMESTAMP:
                result[key] = datetime.now(timezone.utc)
            elif value is firestore.DELETE_FIELD:
                result[key] = firestore.DELETE_FIELD
            else:
                result[key] = deepcopy(value)
        return result

    def set(self, values, merge=False):
        cleaned = self._replace_special_values(values)
        existing = self.database.docs.get(self.path, {}) if merge else {}
        for key, value in cleaned.items():
            if value is firestore.DELETE_FIELD:
                existing.pop(key, None)
            else:
                existing[key] = value
        self.database.docs[self.path] = existing

    def update(self, values):
        if self.path not in self.database.docs:
            raise KeyError(self.path)
        self.set(values, merge=True)

    def create(self, values):
        if self.path in self.database.docs:
            raise ValueError("Document already exists")
        self.set(values)

    def delete(self):
        self.database.docs.pop(self.path, None)


class FakeCollection:
    def __init__(self, database, path):
        self.database = database
        self.path = path

    def get(self):
        prefix = f"{self.path}/"
        return [
            FakeSnapshot(path, data)
            for path, data in sorted(self.database.docs.items())
            if path.startswith(prefix) and "/" not in path[len(prefix):]
        ]

    def document(self, document_id):
        return FakeReference(self.database, f"{self.path}/{document_id}")


class FakeFirestore:
    def __init__(self):
        now = datetime.now(timezone.utc)
        self.course_path = "users/learner-a/courses/python"
        self.docs = {
            self.course_path: {"courseName": "Python", "syllabusStatus": "ready", "syllabusVersion": 1},
            f"{self.course_path}/syllabus/v1": {
                "modules": [{"module_id": "module-1", "title": "Basics", "topics": [
                    {"topic_id": "module-1-topic-1", "title": "Values"},
                    {"topic_id": "module-1-topic-2", "title": "Variables"},
                ]}],
            },
            f"{self.course_path}/tutor/state": {
                "active_topic_id": "module-1-topic-2",
                "topic_status": {"module-1-topic-1": "completed", "module-1-topic-2": "not_started"},
            },
            f"{self.course_path}/tutorCompletions/v1-module-1-topic-1": {
                "courseId": "python", "topicId": "module-1-topic-1", "lessonTitle": "Values",
                "moduleTitle": "Basics", "syllabusVersion": 1, "completedAt": now,
            },
            f"{self.course_path}/tutorCompletions/missing-timestamp": {
                "courseId": "python", "topicId": "module-1-topic-2", "lessonTitle": "Variables",
                "moduleTitle": "Basics", "syllabusVersion": 1,
            },
            "users/learner-a/learningGoals/pre-syllabus": {"courseName": "New course"},
            "users/learner-a/studySessions/planned-one": {
                "courseId": "python", "lessonId": "module-1-topic-2", "lessonTitle": "Variables",
                "startAt": now + timedelta(hours=2), "durationMinutes": 45,
                "note": "Practice examples", "status": "scheduled",
            },
            "users/learner-b/courses/private": {"courseName": "Private"},
            "users/learner-b/studySessions/secret": {
                "courseId": "private", "startAt": now + timedelta(hours=1), "status": "scheduled",
                "durationMinutes": 30, "note": "secret",
            },
        }

    def collection(self, path):
        return FakeCollection(self, path)

    def document(self, path):
        return FakeReference(self, path)


class StudyPlannerEndpointTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeFirestore()
        app.dependency_overrides[get_current_user] = lambda: {"uid": "learner-a"}
        self.database_patch = patch.object(study_planner, "get_firestore_client", return_value=self.database)
        self.database_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.database_patch.stop()
        app.dependency_overrides.clear()

    def overview(self, time_zone="UTC"):
        now = datetime.now(timezone.utc)
        return self.client.get("/api/planner/overview", params={
            "startAt": (now - timedelta(days=7)).isoformat(),
            "endAt": (now + timedelta(days=14)).isoformat(),
            "timeZone": time_zone,
        })

    def test_invalid_time_zone_returns_actionable_validation_error(self):
        response = self.overview("Not/A-Time-Zone")

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "Choose a valid time zone.")

    def test_supported_zones_use_local_monday_midnight_and_dst_week_lengths(self):
        cases = [
            ("Asia/Kolkata", datetime(2026, 10, 15, 12, tzinfo=timezone.utc), 168),
            ("America/Los_Angeles", datetime(2026, 3, 8, 12, tzinfo=timezone.utc), 167),
            ("Europe/London", datetime(2026, 3, 29, 12, tzinfo=timezone.utc), 167),
            ("UTC", datetime(2026, 10, 15, 12, tzinfo=timezone.utc), 168),
        ]
        for name, now, expected_hours in cases:
            with self.subTest(time_zone=name):
                week_start, start_utc, end_utc = study_planner._local_week_window(now, ZoneInfo(name))
                self.assertEqual(week_start.weekday(), 0)
                self.assertEqual((end_utc - start_utc).total_seconds() / 3600, expected_hours)

    def test_weekly_completion_date_is_bucketed_in_each_users_zone(self):
        event = datetime(2026, 10, 12, 0, 30, tzinfo=timezone.utc)
        cases = [
            ("Asia/Kolkata", "2026-10-12"),
            ("America/Los_Angeles", "2026-10-11"),
            ("Europe/London", "2026-10-12"),
            ("UTC", "2026-10-12"),
        ]
        for name, expected_date in cases:
            with self.subTest(time_zone=name):
                zone = ZoneInfo(name)
                local_date = event.astimezone(zone).date()
                week_start, _, _ = study_planner._local_week_window(event, zone)
                activity = dict(study_planner._weekly_activity_counts([event], week_start, zone))
                self.assertEqual(local_date.isoformat(), expected_date)
                self.assertEqual(activity[expected_date], 1)
                self.assertEqual(sum(activity.values()), 1)

    def test_missing_time_zone_uses_explicit_utc_fallback_and_invalid_values_fail(self):
        now = datetime.now(timezone.utc)
        start_at = (now - timedelta(days=7)).isoformat()
        end_at = (now + timedelta(days=14)).isoformat()
        missing = self.client.get("/api/planner/overview", params={"startAt": start_at, "endAt": end_at})
        invalid = self.client.get("/api/planner/overview", params={"startAt": start_at, "endAt": end_at, "timeZone": "../invalid"})
        self.assertEqual(missing.status_code, 200)
        self.assertEqual(invalid.status_code, 422)

    def test_overview_is_uid_scoped_and_contains_real_completion_events(self):
        response = self.overview()

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual({course["courseId"] for course in payload["courses"]}, {"python", "pre-syllabus"})
        self.assertEqual(len(payload["sessions"]), 1)
        self.assertEqual(payload["sessions"][0]["status"], "scheduled")
        self.assertEqual(len(payload["completions"]), 1)
        self.assertEqual(payload["weeklyCompletedLessons"], 1)
        self.assertEqual(sum(day["completedLessons"] for day in payload["weeklyActivity"]), 1)

    def test_create_is_idempotent_editable_cancellable_and_deletable(self):
        operation_id = "12345678-1234-4234-8234-123456789abc"
        start_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        body = {
            "operationId": operation_id, "courseId": "python", "lessonId": "module-1-topic-2",
            "startAt": start_at, "durationMinutes": 60, "note": "Review variables",
        }
        created = self.client.post("/api/planner/sessions", json=body)
        repeated = self.client.post("/api/planner/sessions", json=body)

        self.assertEqual(created.status_code, 201)
        self.assertEqual(repeated.status_code, 201)
        session_id = created.json()["sessionId"]
        self.assertEqual(session_id, repeated.json()["sessionId"])
        path = f"users/learner-a/studySessions/{session_id}"
        self.assertIn(path, self.database.docs)
        self.assertNotIn(f"users/learner-b/studySessions/{session_id}", self.database.docs)

        updated = self.client.patch(f"/api/planner/sessions/{session_id}", json={
            "durationMinutes": 90, "note": "Updated plan",
        })
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["durationMinutes"], 90)
        self.assertEqual(updated.json()["note"], "Updated plan")

        cancelled = self.client.patch(f"/api/planner/sessions/{session_id}/status", json={"status": "cancelled"})
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual(self.database.docs[self.database.course_path + "/tutor/state"]["topic_status"]["module-1-topic-2"], "not_started")
        self.assertEqual(self.client.delete(f"/api/planner/sessions/{session_id}").status_code, 204)
        self.assertNotIn(path, self.database.docs)

    def test_explicit_session_completion_does_not_complete_its_lesson(self):
        response = self.client.patch("/api/planner/sessions/planned-one/status", json={"status": "completed"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "completed")
        self.assertEqual(self.database.docs[self.database.course_path + "/tutor/state"]["topic_status"]["module-1-topic-2"], "not_started")
        timestamped_events = [
            data for path, data in self.database.docs.items()
            if "tutorCompletions" in path and data.get("completedAt") is not None
        ]
        self.assertEqual(len(timestamped_events), 1)

    def test_course_lesson_and_session_edits_are_validated(self):
        base = {
            "operationId": "22345678-1234-4234-8234-123456789abc",
            "courseId": "private", "lessonId": None,
            "startAt": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "durationMinutes": 30, "note": "",
        }
        self.assertEqual(self.client.post("/api/planner/sessions", json=base).status_code, 404)

        base.update(courseId="python", lessonId="not-a-saved-lesson")
        self.assertEqual(self.client.post("/api/planner/sessions", json=base).status_code, 422)

        base.update(lessonId=None, startAt="2020-01-01T10:00:00Z")
        self.assertEqual(self.client.post("/api/planner/sessions", json=base).status_code, 422)

        self.assertEqual(self.client.patch("/api/planner/sessions/secret", json={"note": "changed"}).status_code, 404)

    def test_weekly_goal_persists_and_can_be_cleared(self):
        saved = self.client.put("/api/planner/weekly-goal", json={"weeklyTarget": 5})
        self.assertEqual(saved.json()["weeklyTarget"], 5)
        self.assertEqual(self.database.docs["users/learner-a/learningSettings/planner"]["weeklyLessonTarget"], 5)

        self.assertEqual(self.overview().json()["weeklyTarget"], 5)
        cleared = self.client.put("/api/planner/weekly-goal", json={"weeklyTarget": None})
        self.assertIsNone(cleared.json()["weeklyTarget"])
        self.assertNotIn("weeklyLessonTarget", self.database.docs["users/learner-a/learningSettings/planner"])


if __name__ == "__main__":
    unittest.main()
