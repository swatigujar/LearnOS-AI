from typing import Literal

from pydantic import BaseModel, Field


class CourseProgressItem(BaseModel):
    courseId: str
    title: str
    syllabusStatus: Literal["ready", "not_generated", "generating", "failed", "unavailable"] = "not_generated"
    completionRate: int = Field(ge=0, le=100)
    completedLessons: int = 0
    totalLessons: int = 0
    currentLesson: str | None = None
    nextLesson: str | None = None
    lastStudiedAt: str | None = None
    status: Literal["not_started", "in_progress", "completed"]


class LearningActivitySummary(BaseModel):
    lastStudyDate: str | None = None
    studySessions: int | None = None
    totalMinutesStudied: int | None = None


class UserProgressSummary(BaseModel):
    overallProgress: float = 0.0
    coursesInProgress: int = 0
    completedCourses: int = 0
    totalCourses: int = 0
    lastStudyActivity: LearningActivitySummary | None = None
    courses: list[CourseProgressItem]
