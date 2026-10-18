import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TutorVisual(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["code", "table", "steps", "flow"]
    title: str = Field(min_length=1, max_length=120)
    code: str = Field(default="", max_length=4000)
    columns: list[str] = Field(default_factory=list, max_length=6)
    rows: list[list[str]] = Field(default_factory=list, max_length=10)
    steps: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_content(self):
        if self.kind == "code" and not self.code.strip():
            raise ValueError("Code visuals need code.")
        if self.kind == "table" and (
            not self.columns or not self.rows or any(len(row) != len(self.columns) for row in self.rows)
        ):
            raise ValueError("Table rows must match their columns.")
        if self.kind in ("steps", "flow") and not self.steps:
            raise ValueError("Step visuals need steps.")
        if any(len(value) > 500 for value in [*self.columns, *self.steps, *(cell for row in self.rows for cell in row)]):
            raise ValueError("Visual labels are too long.")
        return self


class TutorReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["teach", "redirect"] = "teach"
    redirect_message: str = Field(default="", max_length=500)
    concepts: list[str] = Field(min_length=1, max_length=8)
    concept_title: str = Field(min_length=1, max_length=120)
    explanation: str = Field(min_length=1, max_length=3000)
    example: str = Field(min_length=1, max_length=2000)
    check_question: str = Field(min_length=1, max_length=500)
    visuals: list[TutorVisual] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def validate_concepts(self):
        if self.intent == "redirect" and not self.redirect_message.strip():
            raise ValueError("Friendly redirects need a message.")
        if any(not concept.strip() or len(concept) > 120 for concept in self.concepts):
            raise ValueError("Concept names must be short and nonempty.")
        if len(set(self.concepts)) != len(self.concepts):
            raise ValueError("Concept names must be unique.")
        if len(json.dumps(self.model_dump(), ensure_ascii=False).encode("utf-8")) > 20_000:
            raise ValueError("Tutor reply is too large to save safely.")
        return self


class GeneratedTutorReply(TutorReply):
    explanation: str = Field(min_length=1, max_length=1200)
    example: str = Field(min_length=1, max_length=600)
    check_question: str = Field(min_length=1, max_length=250)


class TutorAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str = Field(pattern=r"^module-\d+-topic-\d+$")
    operationId: str = Field(pattern=r"^[a-zA-Z0-9-]{16,64}$")
    revision: int = Field(ge=0)
    action: Literal["start", "message", "explain", "confirm", "confirm_module", "pause", "resume", "select", "repeat", "restart"]
    message: str = Field(default="", max_length=2000)
    conceptIndex: int | None = Field(default=None, ge=0, le=7)

    @model_validator(mode="after")
    def validate_action(self):
        if self.action == "message" and not self.message.strip():
            raise ValueError("A message is required.")
        if self.action == "confirm" and self.conceptIndex is None:
            raise ValueError("Confirmation must identify the concept shown.")
        return self


class TutorMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, max_length=150)
    role: Literal["user", "assistant"]
    text: str = Field(default="", max_length=4000)
    reply: TutorReply | None = None
    channel: Literal["chat", "voice"] = "chat"

    @model_validator(mode="after")
    def validate_reply(self):
        if self.role == "assistant" and self.reply is None and not self.text.strip():
            raise ValueError("Assistant messages require validated reply content.")
        return self


class TutorLiveSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str = Field(pattern=r"^module-\d+-topic-\d+$")


class TutorLiveTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=2000)


class TutorLiveTokenCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    modality: Literal["TEXT", "AUDIO", "IMAGE", "VIDEO", "DOCUMENT"]
    token_count: int = Field(ge=0, le=10_000_000)


class TutorLiveUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    output_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    thinking_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    total_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    prompt_tokens_details: list[TutorLiveTokenCount] = Field(default_factory=list, max_length=8)
    response_tokens_details: list[TutorLiveTokenCount] = Field(default_factory=list, max_length=8)


class TutorLiveTranscriptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    topicId: str = Field(pattern=r"^module-\d+-topic-\d+$")
    progressEpoch: int = Field(default=0, ge=0)
    operationId: str = Field(pattern=r"^[a-zA-Z0-9-]{16,64}$")
    turns: list[TutorLiveTurn] = Field(min_length=1, max_length=2)
    usage: TutorLiveUsage | None = None


class TutorConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    concepts: list[str] = Field(default_factory=list, max_length=8)
    concept_index: int = Field(default=0, ge=0, le=7)
    taught_index: int | None = Field(default=None, ge=0, le=7)
    answered_index: int | None = Field(default=None, ge=0, le=7)
    messages: list[TutorMessage] = Field(default_factory=list, max_length=20)


class TutorStateResponse(BaseModel):
    learner_name: str
    active_topic_id: str
    syllabus_version: int
    progress_epoch: int = 0
    revision: int
    paused: bool
    busy: bool
    pending_operation_id: str | None = None
    topic_status: dict[str, Literal["not_started", "in_progress", "completed"]]
    module_status: dict[str, Literal["not_started", "in_progress", "completed"]]
    conversation: TutorConversation
    can_confirm: bool


class TutorCancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    operationId: str = Field(pattern=r"^[a-zA-Z0-9-]{16,64}$")


class TutorHistoryResponse(BaseModel):
    messages: list[TutorMessage] = Field(default_factory=list, max_length=50)
    next_cursor: str | None = None
