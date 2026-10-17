from typing import Literal

from fastapi import APIRouter, Depends, Path, Query

from app.api.dependencies import get_current_user
from app.api.schemas.practice import (
    InterviewCatalog, InterviewCheckRequest, InterviewCheckResponse, InterviewQuestionList,
    InterviewResult, InterviewSubmitRequest, PracticeAnswerRequest, PracticeAttemptList,
    PracticeCourseCatalog, PracticeCourseList, PracticeCourseTopics, PracticeQuestionList,
    PracticeResult, PracticeGenerateRequest,
    PracticeGeneratedSetResponse, PracticeGeneratedSubmitRequest, PracticeGeneratedResult, ScenarioCatalogResponse,
    ScenarioReviewedResult, ScenarioSubmitRequest,
)
from app.services.practice import (
    check_interview_answer, get_interview_catalog, get_interview_questions,
    generate_practice_questions, submit_generated_practice,
    get_practice_attempt, get_scenario_catalog, list_practice_courses, list_practice_course_topics, list_practice_topics,
    read_practice_attempts, read_practice_questions, submit_interview,
    submit_practice, submit_scenario,
)

router = APIRouter(prefix="/api/practice", tags=["practice"])


@router.get("/courses", response_model=PracticeCourseList)
def practice_courses(user: dict = Depends(get_current_user)):
    return list_practice_topics(user)


@router.get("/courses/catalog", response_model=PracticeCourseCatalog)
def practice_course_catalog(user: dict = Depends(get_current_user)):
    return list_practice_courses(user)


@router.get("/courses/{courseId}/topics", response_model=PracticeCourseTopics)
def practice_course_topics(courseId: str = Path(min_length=1, max_length=150, pattern=r"^[^/]+$"),
                           user: dict = Depends(get_current_user)):
    return list_practice_course_topics(courseId, user)


@router.get("/questions", response_model=PracticeQuestionList)
def practice_questions(courseId: str = Query(min_length=1, max_length=150, pattern=r"^[^/]+$"),
    topicId: str = Query(min_length=1, max_length=80, pattern=r"^[^/]+$"), syllabusVersion: int = Query(ge=1),
    difficulty: Literal["Easy", "Medium", "Hard"] = Query(), user: dict = Depends(get_current_user)):
    return read_practice_questions(courseId, topicId, syllabusVersion, difficulty, user)


@router.post("/submit", response_model=PracticeResult)
def practice_submit(request: PracticeAnswerRequest, user: dict = Depends(get_current_user)):
    return submit_practice(request.courseId, request.topicId, request.syllabusVersion, request.difficulty, request.answers, user)


@router.post("/generate", response_model=PracticeGeneratedSetResponse)
def generate_practice(request: PracticeGenerateRequest, user: dict = Depends(get_current_user)):
    return generate_practice_questions(request, user)


@router.post("/generated-submit", response_model=PracticeGeneratedResult)
def generated_practice_submit(request: PracticeGeneratedSubmitRequest, user: dict = Depends(get_current_user)):
    return submit_generated_practice(request, user)


@router.get("/attempts", response_model=PracticeAttemptList)
def practice_attempts(user: dict = Depends(get_current_user)):
    return read_practice_attempts(user)


@router.get("/attempts/{attemptId}")
def practice_attempt_detail(attemptId: str, user: dict = Depends(get_current_user)):
    return get_practice_attempt(attemptId, user)


@router.get("/interview/catalog", response_model=InterviewCatalog)
def interview_catalog(user: dict = Depends(get_current_user)):
    return get_interview_catalog()


@router.get("/interview/questions", response_model=InterviewQuestionList)
def interview_questions(category: str = Query(min_length=1, max_length=40),
                        difficulty: Literal["Easy", "Medium", "Hard"] = Query(),
                        user: dict = Depends(get_current_user)):
    return get_interview_questions(category, difficulty)


@router.post("/interview/check", response_model=InterviewCheckResponse)
def interview_check(request: InterviewCheckRequest, user: dict = Depends(get_current_user)):
    return check_interview_answer(request.category, request.difficulty, request.questionId, request.answer)


@router.post("/interview/submit", response_model=InterviewResult)
def interview_submit(request: InterviewSubmitRequest, user: dict = Depends(get_current_user)):
    return submit_interview(request.category, request.difficulty, request.answers, request.revisionQuestionIds, user)


@router.get("/scenarios", response_model=ScenarioCatalogResponse)
def scenarios(user: dict = Depends(get_current_user)):
    return get_scenario_catalog()


@router.post("/scenarios/submit", response_model=ScenarioReviewedResult)
def scenario_submit(request: ScenarioSubmitRequest, user: dict = Depends(get_current_user)):
    return submit_scenario(request.scenarioId, request.response, request.checklistIds, request.forRevision, user)
