from fastapi import APIRouter, Depends, HTTPException
from firebase_admin import firestore
from pydantic import ValidationError
from datetime import date, datetime, timedelta, timezone
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


@router.post("/research", response_model=CourseResearchPipelineResponse)
def research_course_topics(
    request: CourseResearchRequest,
    user: dict = Depends(get_current_user),
) -> CourseResearchPipelineResponse:
    if not user.get("uid"):
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")
    try:
        execution_id, research = research_course(request)
    except AIProviderError as exc:
        raise HTTPException(status_code=502, detail="Course research failed; no syllabus was generated.") from exc
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Course research returned invalid data; no syllabus was generated.") from exc
    try:
        summary = summarize_research(execution_id, request, research)
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
    try:
        database = get_firestore_client()
        course_ref = database.document(f"users/{user_id}/courses/{request.courseId}")
        legacy_ref = database.document(f"users/{user_id}/learningGoals/{request.courseId}")
        data, saved = _claim_generation(database.transaction(), course_ref, legacy_ref, generation_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Firestore is unavailable; check Firebase Admin configuration.") from exc
    if saved:
        return saved
    try:
        course_input = _course_input(request.courseId, data)
        if request.executionId or request.researchSummary is not None:
            generated = generate_syllabus(
                course_input,
                execution_id=request.executionId,
                research_summary=request.researchSummary,
            )
        else:
            generated = generate_syllabus(course_input)
        syllabus = GeneratedSyllabus.model_validate(generated)
        validate_syllabus_for_request(syllabus, course_input)
        return _finish_generation(database.transaction(), course_ref, legacy_ref, generation_id, syllabus, course_input)
    except Exception as exc:
        try:
            _finish_generation(database.transaction(), course_ref, legacy_ref, generation_id, None, None)
        except Exception:
            raise HTTPException(status_code=503, detail="Generation failed and its status could not be saved. Retry after 10 minutes.") from exc
        if isinstance(exc, HTTPException):
            raise
        if isinstance(exc, (ValidationError, ValueError, TypeError)):
            raise HTTPException(status_code=422, detail="Stored course or generated syllabus is invalid; nothing was saved.") from exc
        if isinstance(exc, SyllabusGenerationError):
            raise HTTPException(status_code=503 if "not configured" in str(exc) else 502, detail=str(exc)) from exc
        raise HTTPException(status_code=503, detail="The generated syllabus could not be saved to Firestore.") from exc