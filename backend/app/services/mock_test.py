import json
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.schemas.mock_test import (
    GeneratedMockQuestionSet,
    MockQuestionBankResponse,
    MockTestResult,
    PublicMockQuestion,
    ReviewedMockQuestion,
)
from app.api.schemas.syllabus import GeneratedSyllabus
from app.core.firebase import get_firestore_client
from app.services.ai_provider import AIProviderError, get_ai_provider


def _course_context(course_id: str, topic_id: str, syllabus_version: int, user: dict):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(401, "Please sign in to continue.")
    database = get_firestore_client()
    course_ref = database.document(f"users/{uid}/courses/{course_id}")
    course_snapshot = course_ref.get()
    course = course_snapshot.to_dict() if course_snapshot.exists else None
    if not course:
        raise HTTPException(404, "Course not found for this user.")
    if course.get("sourceLearningGoalId") == course_id:
        legacy_ref = database.document(f"users/{uid}/learningGoals/{course_id}")
        if not legacy_ref.get().exists:
            raise HTTPException(404, "This course was deleted.")
    version = course.get("syllabusVersion")
    if course.get("syllabusStatus") != "ready" or type(version) is not int or version < 1:
        raise HTTPException(409, "A saved, ready syllabus is required before a mock test.")
    if version != syllabus_version:
        raise HTTPException(409, "The saved syllabus changed. Reload the topic list before continuing.")
    syllabus_ref = course_ref.collection("syllabus").document(f"v{version}")
    saved_syllabus = syllabus_ref.get()
    if not saved_syllabus.exists:
        raise HTTPException(409, "The saved syllabus is missing.")
    try:
        saved_data = saved_syllabus.to_dict() or {}
        syllabus = GeneratedSyllabus.model_validate({
            key: value for key, value in saved_data.items()
            if key in GeneratedSyllabus.model_fields
        })
    except ValidationError as exc:
        raise HTTPException(409, "The saved syllabus needs review before a mock test.") from exc
    selected = next(
        ((module, topic) for module in syllabus.modules for topic in module.topics if topic.topic_id == topic_id),
        None,
    )
    if selected is None:
        raise HTTPException(404, "This topic is not in the saved syllabus.")
    module, topic = selected
    bank_id = f"v{version}_{topic_id}"
    bank_ref = course_ref.collection("mockQuestionBanks").document(bank_id)
    return database, course_ref, course, syllabus, module, topic, bank_ref, version


@firestore.transactional
def _claim_generation(transaction, bank_ref, attempt_id: str, version: int, topic_id: str):
    snapshot = bank_ref.get(transaction=transaction)
    if snapshot.exists:
        current = snapshot.to_dict() or {}
        status = current.get("status")
        valid_ready_bank = False
        if status == "ready":
            try:
                GeneratedMockQuestionSet.model_validate({"questions": current.get("questions")})
                valid_ready_bank = True
            except ValidationError:
                pass
        started_at = current.get("started_at")
        if isinstance(started_at, datetime):
            started_at = started_at.replace(tzinfo=timezone.utc) if started_at.tzinfo is None else started_at
        stale_generation = status == "generating" and isinstance(started_at, datetime) \
            and datetime.now(timezone.utc) - started_at > timedelta(minutes=3)
        can_explicitly_retry = status in ("failed", "budget_blocked", "uncertain") or stale_generation or status == "ready" and not valid_ready_bank
        if valid_ready_bank or status == "generating" and not stale_generation:
            return current, False
        if not can_explicitly_retry or current.get("attempt_id") == attempt_id:
            return current, False
        current = {
            "status": "generating",
            "attempt_id": attempt_id,
            "syllabus_version": version,
            "topic_id": topic_id,
            "questions": [],
            "started_at": datetime.now(timezone.utc),
        }
        transaction.set(bank_ref, current)
        return current, True
    transaction.create(bank_ref, {
        "status": "generating",
        "attempt_id": attempt_id,
        "syllabus_version": version,
        "topic_id": topic_id,
        "questions": [],
        "started_at": datetime.now(timezone.utc),
    })
    return {"status": "generating", "attempt_id": attempt_id}, True


@firestore.transactional
def _finish_generation(transaction, bank_ref, attempt_id: str, data: dict):
    snapshot = bank_ref.get(transaction=transaction)
    current = snapshot.to_dict() if snapshot.exists else None
    if not current or current.get("status") != "generating" or current.get("attempt_id") != attempt_id:
        return False
    transaction.set(bank_ref, data)
    return True


def _public_response(status: str, questions: list[dict] | None = None) -> MockQuestionBankResponse:
    public_questions = [
        PublicMockQuestion(questionId=f"q{index}", prompt=item["prompt"], options=item["options"])
        for index, item in enumerate(questions or [], start=1)
    ]
    return MockQuestionBankResponse(status=status, questions=public_questions)


def _generation_status(data: dict) -> str:
    if data.get("status") == "generating":
        started_at = data.get("started_at")
        if isinstance(started_at, datetime):
            started_at = started_at.replace(tzinfo=timezone.utc) if started_at.tzinfo is None else started_at
            if datetime.now(timezone.utc) - started_at > timedelta(minutes=3):
                return "uncertain"
        return "pending"
    return str(data.get("status", "failed"))


def get_question_bank(course_id: str, topic_id: str, syllabus_version: int, user: dict) -> MockQuestionBankResponse:
    _, _, _, _, _, _, bank_ref, _ = _course_context(course_id, topic_id, syllabus_version, user)
    snapshot = bank_ref.get()
    if not snapshot.exists:
        return _public_response("missing")
    data = snapshot.to_dict() or {}
    status = _generation_status(data)
    if status == "ready":
        try:
            bank = GeneratedMockQuestionSet.model_validate({"questions": data.get("questions")})
        except ValidationError:
            return _public_response("failed")
        return _public_response("ready", [item.model_dump() for item in bank.questions])
    if status in ("generating", "pending"):
        return _public_response("pending")
    if status in ("failed", "budget_blocked", "uncertain"):
        return _public_response(status)
    return _public_response("failed")


def _budget_blocked(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(value in message for value in (
        "request limit has been reached", "estimated-cost limit has been reached",
        "pricing is not configured", "pricing configuration is invalid",
        "usage limits are unavailable", "usage records need review", "cost records need review",
    ))


def _generate_prompt(course: dict, module, topic) -> str:
    context = {
        "course_name": course.get("course_name", course.get("courseName")),
        "skill_level": course.get("skill_level", course.get("skillLevel")),
        "module_title": module.title,
        "topic": {"title": topic.title, "description": topic.description},
    }
    return (
        "Create exactly six concise, accurate multiple-choice questions for this saved course topic. "
        "Use the stated skill level and the topic scope. Each question must have four distinct options, exactly "
        "one defensibly correct answer index from 0 to 3, and a brief explanation. Avoid ambiguous or duplicate questions. "
        "Do not test content outside the selected topic. Return only the JSON object matching the supplied schema. "
        "Saved context:\n" + json.dumps(context, ensure_ascii=True)
    )


def start_question_bank(course_id: str, topic_id: str, syllabus_version: int, attempt_id: str, user: dict) -> MockQuestionBankResponse:
    database, _, course, syllabus, module, topic, bank_ref, version = _course_context(course_id, topic_id, syllabus_version, user)
    try:
        claim, claimed = _claim_generation(database.transaction(), bank_ref, attempt_id, version, topic_id)
    except Exception as exc:
        raise HTTPException(503, "The saved question bank could not be checked. No questions were generated.") from exc

    if not claimed:
        status = _generation_status(claim)
        if status == "ready":
            return get_question_bank(course_id, topic_id, version, user)
        return _public_response("pending" if status in ("generating", "pending") else
                                status if status in ("failed", "budget_blocked", "uncertain") else "failed")

    try:
        provider_result = get_ai_provider().generate_structured(
            _generate_prompt(course, module, topic),
            GeneratedMockQuestionSet.model_json_schema(),
            feature="mock_test",
            request_id=attempt_id,
            max_output_tokens=1800,
        )
        bank = GeneratedMockQuestionSet.model_validate_json(provider_result.text)
        stored_questions = [item.model_dump(mode="json") for item in bank.questions]
        saved = _finish_generation(database.transaction(), bank_ref, attempt_id, {
            "status": "ready",
            "attempt_id": attempt_id,
            "syllabus_version": version,
            "topic_id": topic_id,
            "questions": stored_questions,
            "started_at": claim.get("started_at"),
        })
        if not saved:
            return _public_response("pending")
        return _public_response("ready", stored_questions)
    except Exception as exc:
        status = ("budget_blocked" if isinstance(exc, AIProviderError) and _budget_blocked(exc)
                  else "uncertain" if isinstance(exc, AIProviderError) and exc.status_code == 504 else "failed")
        try:
            _finish_generation(database.transaction(), bank_ref, attempt_id, {
                "status": status,
                "attempt_id": attempt_id,
                "syllabus_version": version,
                "topic_id": topic_id,
                "questions": [],
                "started_at": claim.get("started_at"),
            })
        except Exception:
            pass
        return _public_response(status)


def submit_question_bank(course_id: str, topic_id: str, syllabus_version: int, answers: dict[str, int], user: dict) -> MockTestResult:
    _, _, _, _, _, _, bank_ref, _ = _course_context(course_id, topic_id, syllabus_version, user)
    snapshot = bank_ref.get()
    if not snapshot.exists or (snapshot.to_dict() or {}).get("status") != "ready":
        raise HTTPException(409, "A saved question bank is not available for this topic.")
    try:
        bank = GeneratedMockQuestionSet.model_validate({"questions": (snapshot.to_dict() or {}).get("questions")})
    except ValidationError as exc:
        raise HTTPException(409, "The saved question bank needs review.") from exc
    expected_ids = {f"q{index}" for index in range(1, 7)}
    if set(answers) - expected_ids or any(index < 0 or index > 3 for index in answers.values()):
        raise HTTPException(422, "Submitted answers do not match this question bank.")
    reviewed = []
    correct_count = 0
    for index, question in enumerate(bank.questions, start=1):
        question_id = f"q{index}"
        selected = answers.get(question_id)
        correct = selected == question.answer_index
        correct_count += int(correct)
        reviewed.append(ReviewedMockQuestion(
            questionId=question_id,
            prompt=question.prompt,
            options=question.options,
            selectedIndex=selected,
            correctIndex=question.answer_index,
            explanation=question.explanation,
            correct=correct,
        ))
    total = len(bank.questions)
    answered = len(answers)
    return MockTestResult(
        total=total,
        correct=correct_count,
        incorrect=answered - correct_count,
        unanswered=total - answered,
        percentage=round(correct_count / total * 100),
        questions=reviewed,
    )
