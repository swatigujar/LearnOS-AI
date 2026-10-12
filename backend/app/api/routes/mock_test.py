from fastapi import APIRouter, Depends, Query

from app.api.dependencies import get_current_user
from app.api.schemas.mock_test import MockQuestionBankResponse, MockTestResult, MockTestStartRequest, MockTestSubmitRequest
from app.services.mock_test import get_question_bank, start_question_bank, submit_question_bank

router = APIRouter(prefix="/api/mock-test", tags=["mock-test"])


@router.get("/bank", response_model=MockQuestionBankResponse)
def read_question_bank(
    courseId: str = Query(min_length=1, max_length=150, pattern=r"^[^/]+$"),
    topicId: str = Query(min_length=1, max_length=80, pattern=r"^[^/]+$"),
    syllabusVersion: int = Query(ge=1),
    user: dict = Depends(get_current_user),
):
    return get_question_bank(courseId, topicId, syllabusVersion, user)


@router.post("/start", response_model=MockQuestionBankResponse)
def start_mock_test(request: MockTestStartRequest, user: dict = Depends(get_current_user)):
    return start_question_bank(request.courseId, request.topicId, request.syllabusVersion, request.attemptId, user)


@router.post("/submit", response_model=MockTestResult)
def submit_mock_test(request: MockTestSubmitRequest, user: dict = Depends(get_current_user)):
    return submit_question_bank(request.courseId, request.topicId, request.syllabusVersion, request.answers, user)
