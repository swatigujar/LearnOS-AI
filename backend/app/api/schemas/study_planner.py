from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StudySessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operationId: str = Field(pattern=r"^[0-9a-fA-F-]{32,36}$")
    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    lessonId: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[^/]+$")
    startAt: datetime
    durationMinutes: int = Field(ge=15, le=240)
    note: str = Field(default="", max_length=1000)

    @field_validator("startAt")
    @classmethod
    def require_timezone(cls, value: datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Session start time must include a timezone.")
        return value


class StudySessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str | None = Field(default=None, min_length=1, max_length=150, pattern=r"^[^/]+$")
    lessonId: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[^/]+$")
    startAt: datetime | None = None
    durationMinutes: int | None = Field(default=None, ge=15, le=240)
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("startAt")
    @classmethod
    def require_timezone(cls, value: datetime | None):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Session start time must include a timezone.")
        return value


class StudySessionStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "cancelled"]


class PlannerLesson(BaseModel):
    lessonId: str
    title: str
    moduleTitle: str
    status: Literal["not_started", "in_progress", "completed"]


class PlannerCourse(BaseModel):
    courseId: str
    title: str
    syllabusStatus: Literal["ready", "not_generated", "generating", "failed", "unavailable"]
    activeLessonId: str | None = None
    lessons: list[PlannerLesson]


class PlannerSession(BaseModel):
    sessionId: str
    courseId: str
    courseTitle: str
    lessonId: str | None = None
    lessonTitle: str | None = None
    startAt: str
    durationMinutes: int
    note: str
    status: Literal["scheduled", "completed", "cancelled"]


class LessonCompletionActivity(BaseModel):
    eventId: str
    courseId: str
    courseTitle: str
    lessonId: str
    lessonTitle: str
    moduleTitle: str
    completedAt: str


class WeeklyActivityDay(BaseModel):
    date: str
    completedLessons: int


class PlannerOverview(BaseModel):
    courses: list[PlannerCourse]
    sessions: list[PlannerSession]
    completions: list[LessonCompletionActivity]
    weeklyCompletedLessons: int = 0
    weeklyActivity: list[WeeklyActivityDay]
