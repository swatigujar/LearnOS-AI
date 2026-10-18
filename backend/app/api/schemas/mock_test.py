from typing import Literal
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


class MockTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str = Field(min_length=1, max_length=80, pattern=r"^[^/]+$")
    syllabusVersion: int = Field(ge=1)


class MockTestSubmitRequest(MockTestRequest):
    answers: dict[str, StrictInt] = Field(default_factory=dict, max_length=10)


class MockTestStartRequest(MockTestRequest):
    attemptId: str = Field(min_length=36, max_length=36, pattern=r"^[0-9a-fA-F-]{36}$")


class GeneratedMockQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=8, max_length=700)
    options: list[str] = Field(min_length=4, max_length=4)
    answer_index: StrictInt = Field(ge=0, le=3)
    explanation: str = Field(min_length=8, max_length=500)

    @field_validator("options")
    @classmethod
    def validate_distinct_options(cls, options):
        normalized = [" ".join(unicodedata.normalize("NFKC", option).casefold().split()) for option in options]
        if any(not option for option in normalized) or len(set(normalized)) != 4:
            raise ValueError("Each question needs four distinct, non-empty options.")
        return options


class GeneratedMockQuestionSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Keep six-question banks readable for existing saved data; new banks contain ten.
    questions: list[GeneratedMockQuestion] = Field(min_length=6, max_length=10)

    @model_validator(mode="after")
    def validate_unique_questions(self):
        if len(self.questions) not in (6, 10):
            raise ValueError("A saved question bank must contain six legacy or ten current questions.")
        prompts = [" ".join(unicodedata.normalize("NFKC", q.prompt).casefold().split()) for q in self.questions]
        if len(set(prompts)) != len(self.questions):
            raise ValueError("The question set must contain distinct questions.")
        return self


class PublicMockQuestion(BaseModel):
    questionId: str
    prompt: str
    options: list[str]


class MockQuestionBankResponse(BaseModel):
    status: Literal["missing", "pending", "ready", "failed", "budget_blocked", "uncertain"]
    questions: list[PublicMockQuestion] = Field(default_factory=list)


class ReviewedMockQuestion(BaseModel):
    questionId: str
    prompt: str
    options: list[str]
    selectedIndex: int | None
    correctIndex: int
    explanation: str
    correct: bool


class MockTestResult(BaseModel):
    total: int
    correct: int
    incorrect: int
    unanswered: int
    percentage: int
    questions: list[ReviewedMockQuestion]
