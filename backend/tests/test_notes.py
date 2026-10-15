import base64
from copy import deepcopy
from datetime import datetime, timezone
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.schemas.notes import GeneratedNotes, NoteResearchResult, NoteSection
from app.api.schemas.syllabus import GeneratedSyllabus, SyllabusSource
from app.api.routes import notes as notes_route
from app.main import app
from app.services import notes as notes_service
from app.services.ai_provider import AIProviderError, GeminiProvider
from app.services.notes import _grounded_source_records, _safe_failure_reason, _validate_grounding


class NotesMemoryReference:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self, transaction=None):
        self.database.read_paths.append(self.path)
        data = deepcopy(self.database.docs.get(self.path))
        return SimpleNamespace(exists=data is not None, to_dict=lambda: data)

    def collection(self, name):
        return SimpleNamespace(
            document=lambda document_id: NotesMemoryReference(self.database, f"{self.path}/{name}/{document_id}")
        )


class NotesMemoryTransaction:
    _read_only = False
    _max_attempts = 1
    _id = b"notes-test-transaction"

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
        for reference, values, merge in self.writes:
            current = self.database.docs.get(reference.path, {}) if merge else {}
            updated = dict(current)
            for key, value in values.items():
                if value is notes_service.firestore.DELETE_FIELD:
                    updated.pop(key, None)
                elif value is notes_service.firestore.SERVER_TIMESTAMP:
                    updated[key] = datetime.now(timezone.utc)
                else:
                    updated[key] = deepcopy(value)
            self.database.docs[reference.path] = updated

    def set(self, reference, values, merge=False):
        self.writes.append((reference, values, merge))


class NotesMemoryFirestore:
    def __init__(self, docs):
        self.docs = docs
        self.read_paths = []

    def document(self, path):
        return NotesMemoryReference(self, path)

    def transaction(self):
        return NotesMemoryTransaction(self)


class NotesSchemaTests(unittest.TestCase):
    def test_failure_reason_includes_only_safe_validation_fields(self):
        validation_error = ValidationError.from_exception_data(
            "GeneratedNotes",
            [{"type": "string_type", "loc": ("title",), "input": "private learner content"}],
        )

        summary = _safe_failure_reason(validation_error)

        self.assertEqual(summary, "title: string_type")
        self.assertNotIn("private learner content", summary)
        self.assertEqual(
            _safe_failure_reason(ValueError("No grounded sources were returned.")),
            "No grounded sources were returned.",
        )
        self.assertEqual(_safe_failure_reason(ValueError("arbitrary generated text")), "")

    def test_grounded_sources_are_required_and_deduplicated(self):
        source = SyllabusSource(title="Python docs", url="https://docs.python.org/3/", source_type="official",
                                description="Official Python documentation.")
        self.assertEqual(len(_grounded_source_records([source, source])), 1)
        with self.assertRaisesRegex(ValueError, "No grounded sources"):
            _grounded_source_records([])

    def test_notes_require_covered_objectives_and_nonnegative_source_refs(self):
        with self.assertRaises(ValidationError):
            NoteSection(heading="Key idea", explanation="A concise explanation.", source_refs=[-1])

        with self.assertRaises(ValidationError):
            GeneratedNotes(
                title="Values", subject_type="programming", summary="Values hold data.",
                sections=[NoteSection(heading="Definition", explanation="A value is data.")],
                coverage_checklist=[{"objective": "Explain values", "covered": False, "evidence": ""}],
                quick_review=["Values hold data."],
            )

    def test_research_claim_must_match_a_google_grounded_source(self):
        research = NoteResearchResult.model_validate({"verified_claims": [{
            "claim_id": "claim-1", "statement": "Verified fact", "source_urls": ["https://example.com/"],
        }]})
        source = SyllabusSource(title="Official guide", url="https://docs.example.org/", source_type="official",
                                description="An official guide.")
        with self.assertRaises(ValueError):
            _validate_grounding(research, [source])


class NotesSavedDataFetchTests(unittest.TestCase):
    def test_worker_loads_owner_course_syllabus_and_saved_tutor_lesson(self):
        uid = "learner-123"
        course_id = "python-course"
        topic_id = "module-1-topic-1"
        course_path = f"users/{uid}/courses/{course_id}"
        source = SyllabusSource(
            title="Python tutorial", url="https://docs.python.org/3/tutorial/", source_type="official",
            description="The official Python tutorial.",
        )
        topic = {
            "topic_id": topic_id, "title": "Python variables", "description": "Explain variable assignment.",
            "estimated_minutes": 60,
        }
        syllabus = GeneratedSyllabus.model_validate({
            "overview": "Learn Python basics.", "objective": "Write basic Python programs.",
            "duration_days": 1, "total_study_hours": 1, "prerequisites": [],
            "modules": [{"module_id": "module-1", "title": "Python basics", "description": "Names and values.",
                         "estimated_hours": 1, "topics": [topic]}],
            "resources": [source.model_dump(mode="json")],
        })
        tutor_reply = {
            "concepts": ["Assignment"], "concept_title": "Assigning a value",
            "explanation": "Assignment binds a name to an object.",
            "example": "count = 3", "check_question": "What value does count reference?", "visuals": [],
        }
        documents = {
            course_path: {"courseName": "Python programming", "goalText": "Learn Python", "skillLevel": "beginner",
                          "syllabusStatus": "ready", "syllabusVersion": 1},
            f"{course_path}/syllabus/v1": syllabus.model_dump(mode="json"),
            f"{course_path}/notes/{notes_service.note_document_id(topic_id, 1)}": {
                "courseId": course_id, "topicId": topic_id, "syllabusVersion": 1,
                "title": topic["title"], "status": "queued", "attempts": 0,
            },
            f"{course_path}/tutor/state": {"topic_status": {topic_id: "completed"}},
            f"{course_path}/tutorTopics/{topic_id}": {
                "concepts": ["Assignment"], "concept_index": 0, "taught_index": None,
                "messages": [
                    {"role": "user", "text": "Why use a variable?", "reply": None},
                    {"role": "assistant", "text": "", "reply": tutor_reply},
                ],
            },
            # Same course ID under another user must never be read for this job.
            "users/another-learner/courses/python-course": {"courseName": "Wrong learner's course"},
        }
        database = NotesMemoryFirestore(documents)
        generated = GeneratedNotes(
            title=topic["title"], subject_type="programming", summary="A variable binds a name to a value.",
            sections=[NoteSection(heading="Assignment", explanation="Assignment binds a name to an object.")],
            coverage_checklist=[{"objective": topic["description"], "covered": True,
                                 "evidence": "Explains name binding and assignment."}],
            quick_review=["Assignment binds a name to an object."],
        )
        provider = Mock()
        provider.model = "test-content-model"
        provider.research_grounded_text.return_value = SimpleNamespace(text="Verified research brief.", sources=[source])
        provider.generate_structured.return_value = SimpleNamespace(text=generated.model_dump_json())
        provider.generate_handwritten_jpeg.return_value = b"\xff\xd8\xfftest-jpeg"
        image_blob = Mock()
        bucket = Mock()
        bucket.blob.return_value = image_blob

        with (
            patch.object(notes_service, "get_firestore_client", return_value=database),
            patch.object(notes_service, "FIREBASE_STORAGE_BUCKET", "notes-test-bucket"),
            patch.object(notes_service, "GEMINI_NOTES_IMAGE_SIZE", "2K"),
            patch.object(notes_service, "GeminiProvider", return_value=provider),
            patch.object(notes_service, "get_firebase_app", return_value=object()),
            patch.object(notes_service.storage, "bucket", return_value=bucket),
        ):
            notes_service.generate_topic_notes(uid, course_id, topic_id, 1)

        research_prompt = provider.research_grounded_text.call_args.args[0]
        notes_prompt = provider.generate_structured.call_args.args[0]
        self.assertIn("Python programming", research_prompt)
        self.assertIn("Python variables", research_prompt)
        self.assertIn("Assignment binds a name to an object.", notes_prompt)
        self.assertIn("Why use a variable?", notes_prompt)
        self.assertIn("Explain variable assignment.", notes_prompt)
        self.assertIn(f"{course_path}/syllabus/v1", database.read_paths)
        self.assertIn(f"{course_path}/tutorTopics/{topic_id}", database.read_paths)
        self.assertFalse(any(path.startswith("users/another-learner/") for path in database.read_paths))
        note = database.docs[f"{course_path}/notes/{notes_service.note_document_id(topic_id, 1)}"]
        self.assertEqual(note["status"], "completed")
        self.assertTrue(note["storagePath"].startswith(f"users/{uid}/courses/{course_id}/notes/"))
        image_blob.upload_from_string.assert_called_once_with(b"\xff\xd8\xfftest-jpeg", content_type="image/jpeg")


class NotesImageProviderTests(unittest.TestCase):
    def test_plain_text_search_research_keeps_google_citation_annotations(self):
        provider = GeminiProvider()
        citation = SimpleNamespace(type="url_citation", title="Python docs", url="https://docs.python.org/3/")
        block = SimpleNamespace(type="text", text="Python lists are mutable.", annotations=[citation])
        step = SimpleNamespace(type="model_output", content=[block])
        interaction = SimpleNamespace(
            output_text="Python lists are mutable.", steps=[step], usage=None, id="research-1",
        )
        client = Mock()
        client.interactions.create.return_value = interaction
        with patch.object(provider, "_client", return_value=client), patch.object(
            provider, "_tracked", side_effect=lambda **kwargs: kwargs["invoke"](),
        ):
            result = provider.research_grounded_text(
                "Verify a Python fact.", feature="notes_research", request_id="research-test",
            )

        self.assertEqual(len(result.sources), 1)
        self.assertEqual(str(result.sources[0].url), "https://docs.python.org/3/")
        request = client.interactions.create.call_args.kwargs
        self.assertEqual(request["tools"], [{"type": "google_search"}])
        self.assertNotIn("response_format", request)

    def test_image_model_returns_a_validated_jpeg_with_requested_format(self):
        provider = GeminiProvider()
        jpeg = b"\xff\xd8\xffnotes"
        client = Mock()
        client.interactions.create.return_value = SimpleNamespace(
            output_image=SimpleNamespace(data=base64.b64encode(jpeg).decode("ascii")), usage=None, id="image-1",
        )
        with patch.object(provider, "_client", return_value=client), patch.object(
            provider, "_tracked", side_effect=lambda **kwargs: kwargs["invoke"](),
        ):
            result = provider.generate_handwritten_jpeg(
                "Validated notes", feature="notes_image", request_id="notes-image-test",
            )

        self.assertEqual(result, jpeg)
        call = client.interactions.create.call_args.kwargs
        self.assertEqual(call["model"], "gemini-3.1-flash-image")
        self.assertEqual(call["response_format"]["mime_type"], "image/jpeg")
        self.assertEqual(call["response_format"]["aspect_ratio"], "3:4")
        self.assertEqual(call["response_format"]["image_size"], "2K")

    def test_image_provider_rejects_non_jpeg_output(self):
        provider = GeminiProvider()
        client = Mock()
        client.interactions.create.return_value = SimpleNamespace(
            output_image=SimpleNamespace(data=base64.b64encode(b"not a jpeg").decode("ascii")), usage=None, id="bad",
        )
        with patch.object(provider, "_client", return_value=client), patch.object(
            provider, "_tracked", side_effect=lambda **kwargs: kwargs["invoke"](),
        ):
            with self.assertRaises(AIProviderError):
                provider.generate_handwritten_jpeg("Validated notes", feature="notes_image", request_id="notes-bad")


class NotesDeletionEndpointTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: {"uid": "authenticated-user"}
        self.cleanup = patch.object(notes_route, "delete_course_notes", return_value=2)
        self.cleanup.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.cleanup.stop()
        app.dependency_overrides.clear()

    def test_course_notes_cleanup_uses_authenticated_owner_and_course_id(self):
        response = self.client.delete("/api/notes/course-123")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"courseId": "course-123", "deletedNotes": 2})
        notes_route.delete_course_notes.assert_called_once_with("authenticated-user", "course-123")

    def test_storage_cleanup_revokes_jobs_before_deleting_private_images(self):
        reference = Mock()
        snapshot = SimpleNamespace(reference=reference, to_dict=lambda: {"status": "completed", "storagePath": "private/path.jpg"})
        notes_collection = Mock()
        notes_collection.stream.return_value = [snapshot]
        course_ref = Mock()
        course_ref.collection.return_value = notes_collection
        database = Mock()
        database.document.return_value = course_ref
        blob = Mock()
        blob.generation = 10
        bucket = Mock()
        bucket.list_blobs.return_value = [blob]

        with patch.object(notes_service, "get_firestore_client", return_value=database), patch.object(
            notes_service, "get_firebase_app", return_value=object(),
        ), patch.object(notes_service.storage, "bucket", return_value=bucket):
            deleted = notes_service.delete_course_notes("authenticated-user", "course-123")

        self.assertEqual(deleted, 1)
        first_batch = database.batch.return_value
        first_batch.set.assert_called_once()
        first_batch.delete.assert_called_once_with(reference)
        self.assertEqual(first_batch.commit.call_count, 2)
        blob.delete.assert_called_once_with(if_generation_match=10)


if __name__ == "__main__":
    unittest.main()
