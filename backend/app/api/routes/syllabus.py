import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from firebase_admin import firestore
from pydantic import ValidationError
from datetime import date, datetime, timedelta, timezone
from time import perf_counter
from uuid import uuid4

from app.api.dependencies import get_current_user
from app.api.schemas.research import CourseResearchRequest
from app.api.schemas.pipeline import CourseResearchPipelineResponse
from app.api.schemas.syllabus import (
    CourseSyllabusRequest,
    GeneratedSyllabus,
    SyllabusGenerateRequest,
    SyllabusGenerateResponse,
)
from app.core.config import GEMINI_MODEL
from app.core.firebase import get_firestore_client
from app.services.ai_provider import AIProviderError
from app.services.course_research import research_course, summarize_research
from app.services.syllabus_generator import (
    SyllabusGenerationError,
    generate_syllabus,
    validate_syllabus_for_request,
)

router = APIRouter(prefix="/api/syllabus", tags=["syllabus"])
logger = logging.getLogger(__name__)


def _existing_research_syllabus(user_id: str, course_id: str):
    """Preflight ownership, saved syllabus reuse, and active generation state."""
    try:
        database = get_firestore_client()
        course_ref = database.document(f"users/{user_id}/courses/{course_id}")
        legacy_ref = database.document(f"users/{user_id}/learningGoals/{course_id}")
        snapshot = course_ref.get()
        data = snapshot.to_dict() if snapshot.exists else None
        if data is None:
            legacy = legacy_ref.get()
            if not legacy.exists:
                raise HTTPException(status_code=404, detail="Course not found for this user.")
            data = legacy.to_dict()
        elif data.get("sourceLearningGoalId") == course_id:
            legacy = legacy_ref.get()
            if not legacy.exists:
                raise HTTPException(status_code=404, detail="The original course no longer exists.")
            detail_fields = set(SyllabusGenerateRequest.model_fields) | {"learning_style"}
            data = {key: value for key, value in data.items() if key not in detail_fields}
            data.update(legacy.to_dict())

        version = data.get("syllabusVersion", 0)
        if not isinstance(version, int) or isinstance(version, bool) or version < 0:
            raise HTTPException(status_code=409, detail="Course has invalid syllabus version metadata.")
        if version > 0:
            syllabus_ref = course_ref.collection("syllabus").document(f"v{version}")
            saved = syllabus_ref.get()
            if not saved.exists:
                raise HTTPException(status_code=409, detail="Existing syllabus version is missing; manual review is required.")
            try:
                syllabus = GeneratedSyllabus.model_validate({
                    key: value for key, value in saved.to_dict().items()
                    if key in GeneratedSyllabus.model_fields
                })
            except ValidationError as exc:
                raise HTTPException(status_code=409, detail="Stored syllabus is invalid; manual review is required.") from exc
            return SyllabusGenerateResponse(
                courseId=course_ref.id,
                syllabusId=syllabus_ref.id,
                syllabusVersion=version,
                syllabus=syllabus,
            )

        started_at = data.get("syllabusGenerationStartedAt")
        if data.get("syllabusStatus") == "generating" and (
            not isinstance(started_at, datetime)
            or started_at > datetime.now(timezone.utc) - timedelta(minutes=10)
        ):
            raise HTTPException(status_code=409, detail="Syllabus generation is already in progress.")
        return None
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Firestore is unavailable; check Firebase Admin configuration.") from exc


@router.post("/research", response_model=CourseResearchPipelineResponse)
def research_course_topics(
    request: CourseResearchRequest,
    user: dict = Depends(get_current_user),
) -> CourseResearchPipelineResponse:
    if not user.get("uid"):
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")
    saved = _existing_research_syllabus(user["uid"], request.courseId)
    if saved is not None:
        return CourseResearchPipelineResponse(
            execution_id=uuid4().hex,
            research=None,
            summary=None,
            syllabus=saved,
        )
    try:
        execution_id, research = research_course(request)
    except AIProviderError as exc:
        status = exc.status_code if exc.status_code in (429, 503, 504) else 502
        raise HTTPException(status_code=status, detail="Course research failed; no syllabus was generated.") from exc
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Course research returned invalid data; no syllabus was generated.") from exc
    try:
        summary = summarize_research(execution_id, request, research)
    except AIProviderError as exc:
        status = exc.status_code if exc.status_code in (429, 503, 504) else 502
        raise HTTPException(status_code=status, detail="Research summarization failed; no syllabus was generated.") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Research summarization failed; no syllabus was generated.") from exc
    syllabus = generate_course_syllabus(
        CourseSyllabusRequest(
            courseId=request.courseId,
            executionId=execution_id,
            researchSummary=summary,
        ),
        user,
    )
    return CourseResearchPipelineResponse(
        execution_id=execution_id,
        research=research,
        summary=summary,
        syllabus=syllabus,
    )


def _course_input(course_id: str, data: dict) -> SyllabusGenerateRequest:
    days = data.get("timeline_days", data.get("targetDays"))
    if data.get("timelineType") == "date" and data.get("targetDate"):
        days = (date.fromisoformat(data["targetDate"]) - datetime.now(timezone.utc).date()).days
    style = data.get("learning_style", data.get("preferredLearningStyle"))
    return SyllabusGenerateRequest(
        course_id=course_id,
        course_name=data.get("course_name", data.get("courseName")),
        learning_goal=data.get("learning_goal", data.get("goalText")),
        skill_level=str(data.get("skill_level", data.get("skillLevel", ""))).lower(),
        timeline_days=days,
        study_hours_per_day=data.get("study_hours_per_day", data.get("studyHoursPerDay")),
        learning_preferences=[style] if isinstance(style, str) and style else style,
        additional_requirements=data.get("additional_requirements", data.get("additionalRequirements")),
    )


@firestore.transactional
def _claim_generation(transaction, course_ref, legacy_ref, generation_id):
    snapshot = course_ref.get(transaction=transaction)
    data = snapshot.to_dict() if snapshot.exists else None
    if data is None:
        legacy = legacy_ref.get(transaction=transaction)
        if not legacy.exists:
            raise HTTPException(status_code=404, detail="Course not found for this user.")
        data = legacy.to_dict()
        data["sourceLearningGoalId"] = course_ref.id
    elif data.get("sourceLearningGoalId") == course_ref.id:
        legacy = legacy_ref.get(transaction=transaction)
        if not legacy.exists:
            raise HTTPException(status_code=404, detail="The original course no longer exists.")
        detail_fields = set(SyllabusGenerateRequest.model_fields) | {"learning_style"}
        data = {key: value for key, value in data.items() if key not in detail_fields}
        data.update(legacy.to_dict())
    version = data.get("syllabusVersion", 0)
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        raise HTTPException(status_code=409, detail="Course has invalid syllabus version metadata.")
    if version > 0:
        syllabus_ref = course_ref.collection("syllabus").document(f"v{version}")
        saved = syllabus_ref.get(transaction=transaction)
        if saved.exists:
            try:
                syllabus = GeneratedSyllabus.model_validate({
                    key: value for key, value in saved.to_dict().items()
                    if key in GeneratedSyllabus.model_fields
                })
            except ValidationError as exc:
                raise HTTPException(status_code=409, detail="Stored syllabus is invalid; manual review is required.") from exc
            transaction.set(course_ref, {"syllabusStatus": "ready", "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
            return data, SyllabusGenerateResponse(
                courseId=course_ref.id, syllabusId=syllabus_ref.id,
                syllabusVersion=version, syllabus=syllabus,
            )
        raise HTTPException(status_code=409, detail="Existing syllabus version is missing; manual review is required.")
    started_at = data.get("syllabusGenerationStartedAt")
    if data.get("syllabusStatus") == "generating" and (
        not isinstance(started_at, datetime)
        or started_at > datetime.now(timezone.utc) - timedelta(minutes=10)
    ):
        raise HTTPException(status_code=409, detail="Syllabus generation is already in progress.")
    updates = {
        "syllabusStatus": "generating",
        "syllabusVersion": version,
        "syllabusGenerationId": generation_id,
        "syllabusGenerationStartedAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    if not snapshot.exists:
        updates = {**data, **updates}
    if not data.get("createdAt"):
        updates["createdAt"] = firestore.SERVER_TIMESTAMP
    transaction.set(course_ref, updates, merge=True)
    return data, None


@firestore.transactional
def _finish_generation(transaction, course_ref, legacy_ref, generation_id, syllabus, course_input):
    snapshot = course_ref.get(transaction=transaction)
    data = snapshot.to_dict() or {}
    if data.get("syllabusGenerationId") != generation_id or data.get("syllabusStatus") != "generating":
        raise HTTPException(status_code=409, detail="This generation attempt is no longer active.")
    version = data.get("syllabusVersion", 0) + 1
    syllabus_ref = course_ref.collection("syllabus").document(f"v{version}")
    existing = syllabus_ref.get(transaction=transaction)
    if existing.exists:
        raise HTTPException(status_code=409, detail="An existing syllabus will not be overwritten.")
    if syllabus is None:
        transaction.update(course_ref, {"syllabusStatus": "failed", "updatedAt": firestore.SERVER_TIMESTAMP})
        return None
    current_data = data
    if data.get("sourceLearningGoalId") == course_ref.id:
        legacy = legacy_ref.get(transaction=transaction)
        if not legacy.exists:
            raise HTTPException(status_code=409, detail="The course was deleted during generation.")
        current_data = legacy.to_dict()
    if _course_input(course_ref.id, current_data) != course_input:
        raise HTTPException(status_code=409, detail="Course details changed during generation. Please retry.")
    transaction.create(syllabus_ref, {
        **syllabus.model_dump(mode="json"),
        "generatedAt": firestore.SERVER_TIMESTAMP,
        "provider": "gemini",
        "model": GEMINI_MODEL,
        "syllabusVersion": version,
    })
    transaction.update(course_ref, {
        **course_input.model_dump(mode="json", exclude={"course_id", "learning_preferences"}),
        "learning_style": (course_input.learning_preferences or [None])[0],
        "syllabusStatus": "ready",
        "syllabusVersion": version,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    return SyllabusGenerateResponse(
        courseId=course_ref.id, syllabusId=syllabus_ref.id,
        syllabusVersion=version, syllabus=syllabus,
    )


@router.post("/generate", response_model=SyllabusGenerateResponse)
def generate_course_syllabus(
    request: CourseSyllabusRequest,
    user: dict = Depends(get_current_user),
) -> SyllabusGenerateResponse:
    user_id = user.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")
    generation_id = uuid4().hex
    request_started = perf_counter()
    claim_duration_ms = None
    generation_validation_duration_ms = None
    finalize_duration_ms = 0
    reused_syllabus = False
    status_code = 500
    try:
        try:
            database = get_firestore_client()
            course_ref = database.document(f"users/{user_id}/courses/{request.courseId}")
            legacy_ref = database.document(f"users/{user_id}/learningGoals/{request.courseId}")
            claim_started = perf_counter()
            try:
                data, saved = _claim_generation(database.transaction(), course_ref, legacy_ref, generation_id)
            finally:
                claim_duration_ms = round((perf_counter() - claim_started) * 1000)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Firestore is unavailable; check Firebase Admin configuration.") from exc
        if saved:
            reused_syllabus = True
            status_code = 200
            return saved

        try:
            generation_started = perf_counter()
            try:
                course_input = _course_input(request.courseId, data)
                if request.executionId or request.researchSummary is not None:
                    generated = generate_syllabus(
                        course_input,
                        execution_id=request.executionId,
                        research_summary=request.researchSummary,
                    )
                else:
                    generated = generate_syllabus(course_input, execution_id=generation_id)
                syllabus = GeneratedSyllabus.model_validate(generated)
                validate_syllabus_for_request(syllabus, course_input)
            finally:
                generation_validation_duration_ms = round((perf_counter() - generation_started) * 1000)

            finalize_started = perf_counter()
            try:
                response = _finish_generation(database.transaction(), course_ref, legacy_ref, generation_id, syllabus, course_input)
            finally:
                finalize_duration_ms += round((perf_counter() - finalize_started) * 1000)
            status_code = 200
            return response
        except Exception as exc:
            finalize_started = perf_counter()
            try:
                _finish_generation(database.transaction(), course_ref, legacy_ref, generation_id, None, None)
            except Exception as save_error:
                status_code = 503
                raise HTTPException(status_code=503, detail="Generation failed and its status could not be saved. Retry after 10 minutes.") from save_error
            finally:
                finalize_duration_ms += round((perf_counter() - finalize_started) * 1000)
            if isinstance(exc, HTTPException):
                raise
            if isinstance(exc, (ValidationError, ValueError, TypeError)):
                raise HTTPException(status_code=422, detail="Stored course or generated syllabus is invalid; nothing was saved.") from exc
            if isinstance(exc, SyllabusGenerationError):
                status = exc.status_code if exc.status_code in (429, 503, 504) else 503 if "not configured" in str(exc) else 502
                raise HTTPException(status_code=status, detail=str(exc)) from exc
            raise HTTPException(status_code=503, detail="The generated syllabus could not be saved to Firestore.") from exc
    except HTTPException as exc:
        status_code = exc.status_code
        raise
    finally:
        logger.info("SYLLABUS_TIMING %s", json.dumps({
            "generation_id": generation_id,
            "status_code": status_code,
            "reused_syllabus": reused_syllabus,
            "claim_duration_ms": claim_duration_ms,
            "generation_validation_duration_ms": generation_validation_duration_ms,
            "finalize_duration_ms": finalize_duration_ms,
            "total_duration_ms": round((perf_counter() - request_started) * 1000),
        }, separators=(",", ":")))
