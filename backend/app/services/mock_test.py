import json
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.schemas.mock_test import (
    GeneratedMockCandidateSet,
    GeneratedMockQuestionSet,
    MockAnswerVerification,
    MockQuestionBankResponse,
    MockTestResult,
    PublicMockQuestion,
    ReviewedMockQuestion,
)
from app.api.schemas.syllabus import GeneratedSyllabus
from app.core.firebase import get_firestore_client
from app.services.ai_provider import AIProviderError, get_ai_provider

QUESTION_COUNT = 10
ATTEMPT_HISTORY_LIMIT = 100
GENERATION_TIMEOUT = timedelta(minutes=3)


def _course_context(course_id: str, topic_id: str | None, syllabus_version: int | None, user: dict):
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
    if topic_id is None:
        return database, course_ref, course, None, None, None
    version = course.get("syllabusVersion")
    if course.get("syllabusStatus") != "ready" or type(version) is not int or version < 1:
        raise HTTPException(409, "A saved, ready syllabus is required before a mock test.")
    if version != syllabus_version:
        raise HTTPException(409, "The saved syllabus changed. Reload the topic list before continuing.")
    saved_syllabus = course_ref.collection("syllabus").document(f"v{version}").get()
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
    return database, course_ref, course, module, topic, version


def _bank_ref(course_ref, attempt_id: str):
    return course_ref.collection("mockQuestionBanks").document(f"attempt_{attempt_id.lower()}")


def _result_ref(course_ref, attempt_id: str):
    return course_ref.collection("mockTestAttempts").document(attempt_id.lower())


def _recent_attempt_docs(course_ref, limit: int) -> list[dict]:
    query = (course_ref.collection("mockTestAttempts")
             .order_by("completedAt", direction=firestore.Query.DESCENDING).limit(limit))
    return [snapshot.to_dict() or {} for snapshot in query.stream()]


def _course_title(course: dict) -> str:
    return str(course.get("course_name") or course.get("courseName") or course.get("title") or "Course")


@firestore.transactional
def _claim_generation(transaction, bank_ref, attempt_id: str, version: int, topic_id: str):
    snapshot = bank_ref.get(transaction=transaction)
    if snapshot.exists:
        return snapshot.to_dict() or {}, False
    current = {
        "status": "generating",
        "attempt_id": attempt_id,
        "syllabus_version": version,
        "topic_id": topic_id,
        "questions": [],
        "started_at": datetime.now(timezone.utc),
    }
    transaction.create(bank_ref, current)
    return current, True


@firestore.transactional
def _finish_generation(transaction, bank_ref, attempt_id: str, data: dict):
    snapshot = bank_ref.get(transaction=transaction)
    current = snapshot.to_dict() if snapshot.exists else None
    if not current or current.get("status") != "generating" or current.get("attempt_id") != attempt_id:
        return False
    transaction.set(bank_ref, data)
    return True


@firestore.transactional
def _save_result(transaction, result_ref, data: dict):
    snapshot = result_ref.get(transaction=transaction)
    if snapshot.exists:
        return snapshot.to_dict() or {}
    transaction.create(result_ref, data)
    return data


def _public_response(status: str, attempt_id: str | None = None, questions: list[dict] | None = None) -> MockQuestionBankResponse:
    public_questions = [
        PublicMockQuestion(questionId=f"q{index}", prompt=item["prompt"], options=item["options"])
        for index, item in enumerate(questions or [], start=1)
    ]
    return MockQuestionBankResponse(status=status, attemptId=attempt_id, questions=public_questions)


def _generation_status(data: dict) -> str:
    status = data.get("status")
    if status == "generating":
        started_at = data.get("started_at")
        if isinstance(started_at, datetime):
            started_at = started_at.replace(tzinfo=timezone.utc) if started_at.tzinfo is None else started_at
            if datetime.now(timezone.utc) - started_at > GENERATION_TIMEOUT:
                return "uncertain"
        return "pending"
    return status if status in ("ready", "failed", "budget_blocked", "uncertain") else "failed"


def _load_bank(data: dict, topic_id: str, version: int) -> GeneratedMockQuestionSet:
    if data.get("topic_id") != topic_id or data.get("syllabus_version") != version:
        raise HTTPException(409, "This saved test belongs to a different topic or syllabus.")
    try:
        return GeneratedMockQuestionSet.model_validate({"questions": data.get("questions")})
    except ValidationError as exc:
        raise HTTPException(409, "The saved question bank needs review.") from exc


def _bank_response(data: dict, attempt_id: str, topic_id: str, version: int) -> MockQuestionBankResponse:
    status = _generation_status(data)
    if status != "ready":
        return _public_response(status, attempt_id)
    try:
        bank = _load_bank(data, topic_id, version)
    except HTTPException:
        return _public_response("failed", attempt_id)
    return _public_response("ready", attempt_id, [item.model_dump() for item in bank.questions])


def get_question_bank(course_id: str, topic_id: str, syllabus_version: int, attempt_id: str | None, user: dict) -> MockQuestionBankResponse:
    _, course_ref, _, _, _, version = _course_context(course_id, topic_id, syllabus_version, user)
    if not attempt_id:
        return _public_response("missing")
    snapshot = _bank_ref(course_ref, attempt_id).get()
    if not snapshot.exists:
        return _public_response("missing", attempt_id)
    return _bank_response(snapshot.to_dict() or {}, attempt_id, topic_id, version)


def _budget_blocked(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(value in message for value in (
        "request limit has been reached", "estimated-cost limit has been reached",
        "pricing is not configured", "pricing configuration is invalid",
        "usage limits are unavailable", "usage records need review", "cost records need review",
    ))


def _recent_prompts(course_ref, topic_id: str) -> list[str]:
    try:
        attempts = _recent_attempt_docs(course_ref, 20)
    except Exception:
        return []
    prompts = []
    for attempt in attempts:
        if attempt.get("topicId") != topic_id:
            continue
        prompts.extend(str(item.get("prompt", ""))[:200] for item in attempt.get("questions") or [] if isinstance(item, dict))
    return [prompt for prompt in prompts if prompt][:30]


def _generate_prompt(course: dict, module, topic, avoid: list[str]) -> str:
    context = {
        "course_name": course.get("course_name", course.get("courseName")),
        "skill_level": course.get("skill_level", course.get("skillLevel")),
        "module_title": module.title,
        "topic": {"title": topic.title, "description": topic.description},
    }
    avoid_text = ("\nDo not repeat or lightly reword these questions from earlier attempts:\n"
                  + json.dumps(avoid, ensure_ascii=True)) if avoid else ""
    return (
        "Create exactly twelve fresh, concise, accurate multiple-choice questions for this saved course topic. "
        "Mix recall, understanding, and application questions at the stated skill level within the topic scope. "
        "Each question must have four distinct options, exactly one defensibly correct answer index from 0 to 3, "
        "and a brief explanation of why that answer is correct. Vary which option position is correct. "
        "Avoid ambiguous, trick, 'all of the above', or duplicate questions. Do not test content outside the selected topic. "
        "Return only the JSON object matching the supplied schema. Saved context:\n"
        + json.dumps(context, ensure_ascii=True) + avoid_text
    )


def _verify_prompt(topic, candidates: GeneratedMockCandidateSet) -> str:
    questions = [
        {"question_number": number, "prompt": item.prompt, "options": item.options}
        for number, item in enumerate(candidates.questions, start=1)
    ]
    return (
        "You are an independent exam reviewer. Solve each multiple-choice question yourself without any answer key. "
        "For every question return its question_number, the index (0 to 3) of the single correct option, and "
        "unambiguous=false if zero or several options could be defended as correct or the question is unclear. "
        f"Topic: {json.dumps(topic.title, ensure_ascii=True)}. Questions:\n" + json.dumps(questions, ensure_ascii=True)
    )


def _verified_questions(provider, attempt_id: str, topic, candidates: GeneratedMockCandidateSet) -> list[dict]:
    verification = MockAnswerVerification.model_validate_json(provider.generate_structured(
        _verify_prompt(topic, candidates),
        MockAnswerVerification.model_json_schema(),
        feature="mock_test",
        request_id=f"{attempt_id}:verify",
        max_output_tokens=1200,
    ).text)
    verdicts = {verdict.question_number: verdict for verdict in verification.verdicts}
    verified = []
    for number, question in enumerate(candidates.questions, start=1):
        verdict = verdicts.get(number)
        if verdict and verdict.unambiguous and verdict.correct_index == question.answer_index:
            verified.append(question.model_dump(mode="json"))
    if len(verified) < QUESTION_COUNT:
        raise ValueError("Too few generated questions passed answer verification.")
    selected = verified[:QUESTION_COUNT]
    GeneratedMockQuestionSet.model_validate({"questions": selected})
    return selected


def start_question_bank(course_id: str, topic_id: str, syllabus_version: int, attempt_id: str, user: dict) -> MockQuestionBankResponse:
    database, course_ref, course, module, topic, version = _course_context(course_id, topic_id, syllabus_version, user)
    bank_ref = _bank_ref(course_ref, attempt_id)
    try:
        claim, claimed = _claim_generation(database.transaction(), bank_ref, attempt_id, version, topic_id)
    except Exception as exc:
        raise HTTPException(503, "The saved question bank could not be checked. No questions were generated.") from exc
    if not claimed:
        return _bank_response(claim, attempt_id, topic_id, version)

    try:
        provider = get_ai_provider()
        candidates = GeneratedMockCandidateSet.model_validate_json(provider.generate_structured(
            _generate_prompt(course, module, topic, _recent_prompts(course_ref, topic_id)),
            GeneratedMockCandidateSet.model_json_schema(),
            feature="mock_test",
            request_id=attempt_id,
            max_output_tokens=4000,
        ).text)
        stored_questions = _verified_questions(provider, attempt_id, topic, candidates)
        saved = _finish_generation(database.transaction(), bank_ref, attempt_id, {
            "status": "ready",
            "attempt_id": attempt_id,
            "syllabus_version": version,
            "topic_id": topic_id,
            "questions": stored_questions,
            "started_at": claim.get("started_at"),
        })
        if not saved:
            return _public_response("pending", attempt_id)
        return _public_response("ready", attempt_id, stored_questions)
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
        return _public_response(status, attempt_id)


def submit_question_bank(course_id: str, topic_id: str, syllabus_version: int, attempt_id: str,
                         answers: dict[str, int], user: dict) -> MockTestResult:
    database, course_ref, course, module, topic, version = _course_context(course_id, topic_id, syllabus_version, user)
    result_ref = _result_ref(course_ref, attempt_id)
    existing = result_ref.get()
    if existing.exists:
        saved = existing.to_dict() or {}
        if saved.get("topicId") != topic_id:
            raise HTTPException(409, "This attempt was already saved for a different topic.")
        return MockTestResult.model_validate(saved)

    snapshot = _bank_ref(course_ref, attempt_id).get()
    data = snapshot.to_dict() if snapshot.exists else None
    if not data or data.get("status") != "ready":
        raise HTTPException(409, "A saved question bank is not available for this test.")
    bank = _load_bank(data, topic_id, version)
    expected_ids = {f"q{index}" for index in range(1, len(bank.questions) + 1)}
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
    result = MockTestResult(
        attemptId=attempt_id.lower(),
        courseId=course_id,
        courseTitle=_course_title(course),
        topicId=topic_id,
        topicTitle=topic.title,
        moduleTitle=module.title,
        syllabusVersion=version,
        completedAt=datetime.now(timezone.utc).isoformat(),
        total=total,
        correct=correct_count,
        incorrect=answered - correct_count,
        unanswered=total - answered,
        percentage=round(correct_count / total * 100),
        questions=reviewed,
    )
    try:
        stored = _save_result(database.transaction(), result_ref, {
            **result.model_dump(mode="json"), "userId": user["uid"],
        })
    except Exception as exc:
        raise HTTPException(503, "Your result could not be saved. Submit again to retry safely.") from exc
    return MockTestResult.model_validate(stored)


def list_attempts(course_id: str, user: dict) -> list[MockTestResult]:
    _, course_ref, _, _, _, _ = _course_context(course_id, None, None, user)
    try:
        documents = _recent_attempt_docs(course_ref, ATTEMPT_HISTORY_LIMIT)
    except Exception as exc:
        raise HTTPException(503, "Saved mock results are unavailable right now.") from exc
    attempts = []
    for document in documents:
        try:
            attempts.append(MockTestResult.model_validate(document))
        except ValidationError:
            continue
    return attempts
