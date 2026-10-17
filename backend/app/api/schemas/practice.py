from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


class PracticeAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str = Field(min_length=1, max_length=80, pattern=r"^[^/]+$")
    syllabusVersion: int = Field(ge=1)
    difficulty: Literal["Easy", "Medium", "Hard"]
    answers: dict[str, StrictInt] = Field(max_length=5)


class PracticeQuestion(BaseModel):
    questionId: str
    prompt: str
    options: list[str]
    difficulty: Literal["Easy", "Medium", "Hard"]


class PracticeTopic(BaseModel):
    topicId: str
    title: str
    moduleTitle: str
    courseId: str
    courseTitle: str
    syllabusVersion: int
    difficulties: list[Literal["Easy", "Medium", "Hard"]]
    questionCount: int
    questionCounts: dict[Literal["Easy", "Medium", "Hard"], int] = Field(default_factory=dict)


class PracticeCourseList(BaseModel):
    topics: list[PracticeTopic]


class PracticeCourseOption(BaseModel):
    courseId: str
    title: str
    syllabusStatus: Literal["ready", "not_generated", "generating", "failed", "unavailable"]


class PracticeCourseCatalog(BaseModel):
    courses: list[PracticeCourseOption]


class PracticeCourseTopic(BaseModel):
    topicId: str
    title: str
    moduleTitle: str
    syllabusVersion: int


class PracticeCourseTopics(BaseModel):
    topics: list[PracticeCourseTopic]


class PracticeQuestionList(BaseModel):
    questions: list[PracticeQuestion]


class PracticeReviewedQuestion(PracticeQuestion):
    selectedIndex: int | None
    correctIndex: int
    explanation: str
    correct: bool


class PracticeResult(BaseModel):
    attemptId: str
    total: int
    correct: int
    incorrect: int
    unanswered: int
    percentage: int
    questions: list[PracticeReviewedQuestion]


class PracticeAttemptSummary(BaseModel):
    attemptId: str
    courseId: str
    courseTitle: str
    topicId: str
    topicTitle: str
    difficulty: Literal["Easy", "Medium", "Hard"]
    completedAt: str | None
    total: int
    correct: int
    incorrect: int
    percentage: int
    mode: Literal["concept", "interview", "scenario"] = "concept"
    category: str | None = None
    revisionCount: int = 0


class PracticeAttemptList(BaseModel):
    attempts: list[PracticeAttemptSummary]


InterviewCategory = str
PracticeDifficulty = Literal["Easy", "Medium", "Hard"]


class InterviewCategoryAvailability(BaseModel):
    category: InterviewCategory
    difficulties: list[PracticeDifficulty]
    questionCount: int
    questionCounts: dict[PracticeDifficulty, int] = Field(default_factory=dict)


class PracticeGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["concept", "interview", "scenario"]
    courseId: str | None = Field(default=None, min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[^/]+$")
    syllabusVersion: int | None = Field(default=None, ge=1)
    category: str | None = Field(default=None, min_length=1, max_length=80)
    targetRole: str | None = Field(default=None, max_length=200)
    difficulty: PracticeDifficulty
    questionCount: int = Field(default=5, ge=1, le=10)
    questionFormat: Literal["mixed", "mcq", "short_answer"] = "mixed"

    @model_validator(mode="after")
    def validate_mode_context(self):
        course_context = (self.courseId, self.topicId, self.syllabusVersion)
        if self.mode in ("concept", "scenario") and not all(course_context):
            raise ValueError("Course practice requires a saved course topic and syllabus version.")
        if self.mode == "interview" and any(course_context) and not all(course_context):
            raise ValueError("Interview course context requires a course, topic, and syllabus version.")
        if self.mode == "interview" and not self.category:
            raise ValueError("Interview generation requires a selected skill or category.")
        if self.mode == "scenario" and self.questionFormat == "mcq":
            raise ValueError("Scenario practice requires a descriptive response format.")
        return self


class GeneratedPracticeQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["mcq", "short_answer", "code_prediction", "debugging"]
    prompt: str = Field(min_length=12, max_length=2000)
    options: list[str] = Field(default_factory=list, max_length=5)
    answerIndex: StrictInt | None = None
    sampleAnswer: str | None = Field(default=None, max_length=4000)
    rubric: list[str] = Field(default_factory=list, max_length=8)
    explanation: str = Field(min_length=8, max_length=2000)
    scenarioTitle: str | None = Field(default=None, min_length=3, max_length=240)
    scenarioContext: str | None = Field(default=None, min_length=12, max_length=3000)
    scenarioTask: str | None = Field(default=None, min_length=12, max_length=2000)
    suggestedNextSteps: list[str] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def validate_answer_metadata(self):
        if self.kind == "mcq":
            if not 2 <= len(self.options) <= 5 or self.answerIndex is None or not 0 <= self.answerIndex < len(self.options):
                raise ValueError("Multiple-choice questions need 2–5 options and a valid answer index.")
            if any(not option.strip() for option in self.options) or len({option.strip().casefold() for option in self.options}) != len(self.options):
                raise ValueError("Multiple-choice options must be non-empty and distinct.")
            if not self.sampleAnswer:
                self.sampleAnswer = self.options[self.answerIndex]
        elif self.options or self.answerIndex is not None or not (self.sampleAnswer and self.sampleAnswer.strip()) or not self.rubric:
            raise ValueError("Descriptive questions need a sample answer and evaluation rubric, without MCQ keys.")
        return self


class GeneratedPracticeQuestionSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    questions: list[GeneratedPracticeQuestion] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def require_distinct_prompts(self):
        prompts = [" ".join(question.prompt.split()).casefold() for question in self.questions]
        if len(set(prompts)) != len(prompts):
            raise ValueError("Generated practice questions must have distinct prompts.")
        return self


class PracticeGeneratedQuestionPublic(BaseModel):
    questionId: str
    kind: Literal["mcq", "short_answer", "code_prediction", "debugging"]
    prompt: str
    options: list[str]
    difficulty: PracticeDifficulty
    scenarioTitle: str | None = None
    scenarioContext: str | None = None
    scenarioTask: str | None = None


class PracticeGeneratedSetResponse(BaseModel):
    setId: str
    sessionId: str
    mode: Literal["concept", "interview", "scenario"]
    source: Literal["generated", "cached"]
    contextTitle: str
    questionCount: int
    adaptationNote: str
    questions: list[PracticeGeneratedQuestionPublic]


class PracticeGeneratedSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setId: str = Field(min_length=1, max_length=64, pattern=r"^[a-f0-9]+$")
    sessionId: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$")
    answers: dict[str, str | StrictInt] = Field(max_length=10)

    @field_validator("answers")
    @classmethod
    def bound_generated_answers(cls, answers):
        if any(isinstance(answer, str) and len(answer) > 6000 for answer in answers.values()):
            raise ValueError("Practice responses must be 6,000 characters or fewer.")
        return answers


class PracticeGeneratedReviewedQuestion(PracticeGeneratedQuestionPublic):
    selectedAnswer: str | int | None
    expectedAnswer: str
    rubric: list[str]
    explanation: str
    correct: bool | None
    suggestedNextSteps: list[str] = Field(default_factory=list)


class PracticeGeneratedResult(BaseModel):
    attemptId: str
    mode: Literal["concept", "interview", "scenario"]
    total: int
    scoreable: int
    correct: int
    incorrect: int
    unanswered: int
    percentage: int | None
    questions: list[PracticeGeneratedReviewedQuestion]


class InterviewCatalog(BaseModel):
    categories: list[InterviewCategoryAvailability]


class InterviewQuestion(BaseModel):
    questionId: str
    category: InterviewCategory
    difficulty: PracticeDifficulty
    kind: Literal["mcq", "descriptive"]
    prompt: str
    options: list[str] = Field(default_factory=list)


class InterviewQuestionList(BaseModel):
    questions: list[InterviewQuestion]


class InterviewCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(min_length=1, max_length=80)
    difficulty: PracticeDifficulty
    questionId: str = Field(min_length=1, max_length=100)
    answer: str | StrictInt


class InterviewCheckResponse(BaseModel):
    questionId: str
    kind: Literal["mcq", "descriptive"]
    correct: bool | None
    expectedAnswer: str
    explanation: str


class InterviewSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(min_length=1, max_length=80)
    difficulty: PracticeDifficulty
    answers: dict[str, str | StrictInt] = Field(max_length=20)
    revisionQuestionIds: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("answers")
    @classmethod
    def bound_descriptive_answers(cls, answers):
        if any(isinstance(answer, str) and len(answer) > 6000 for answer in answers.values()):
            raise ValueError("Descriptive answers must be 6,000 characters or fewer.")
        return answers


class InterviewReviewedQuestion(InterviewQuestion):
    selectedAnswer: str | int | None
    expectedAnswer: str
    explanation: str
    correct: bool | None
    forRevision: bool


class InterviewResult(BaseModel):
    attemptId: str
    mode: Literal["interview"] = "interview"
    category: InterviewCategory
    difficulty: PracticeDifficulty
    total: int
    scoreable: int
    answered: int
    correct: int
    incorrect: int
    unanswered: int
    percentage: int | None
    revisionCount: int
    questions: list[InterviewReviewedQuestion]


class ScenarioSummary(BaseModel):
    scenarioId: str
    category: str
    title: str
    difficulty: PracticeDifficulty


class ScenarioChecklistItem(BaseModel):
    id: str
    label: str


class ScenarioReviewedChecklistItem(ScenarioChecklistItem):
    selected: bool


class ScenarioCatalog(BaseModel):
    scenarios: list[ScenarioSummary]


class ScenarioView(ScenarioSummary):
    description: str
    context: str
    task: str
    checklist: list[ScenarioChecklistItem]


class ScenarioCatalogResponse(BaseModel):
    scenarios: list[ScenarioView]


class ScenarioSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenarioId: str = Field(min_length=1, max_length=100)
    response: str = Field(min_length=1, max_length=12000)
    checklistIds: list[str] = Field(default_factory=list, max_length=20)
    forRevision: bool = False


class ScenarioReviewedResult(ScenarioView):
    attemptId: str
    mode: Literal["scenario"] = "scenario"
    response: str
    referenceAnswer: str
    checklist: list[ScenarioReviewedChecklistItem]
    explanation: str
    suggestedNextSteps: list[str]
    forRevision: bool
