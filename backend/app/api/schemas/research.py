from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class CourseResearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    courseName: str = Field(min_length=1, max_length=120)
    goalText: str = Field(min_length=1, max_length=2000)
    skillLevel: Literal["beginner", "intermediate", "advanced"]
    timelineType: Literal["days", "date"]
    targetDays: int | None = Field(default=None, ge=1, le=3650)
    targetDate: str
    studyHoursPerDay: float = Field(gt=0, le=24)
    preferredLearningStyle: str = Field(max_length=100)
    additionalRequirements: str = Field(max_length=2000)


class ResearchSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    url: HttpUrl


class CourseResearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    important_topics: list[str]
    key_concepts: list[str] = Field(default_factory=list)
    prerequisites: list[str]
    recommended_learning_order: list[str]
    important_subtopics: list[str] = Field(default_factory=list)
    outcome_topics: list[str] = Field(default_factory=list)
    sources: list[ResearchSource]
    resource_suggestions: list[ResearchSource] = Field(default_factory=list)


class CourseResearchSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=4000)
    important_topics: list[str]
    key_concepts: list[str]
    prerequisites: list[str]
    recommended_learning_order: list[str]
    important_subtopics: list[str]
    outcome_topics: list[str]
    resource_suggestions: list[ResearchSource]


class CourseResearchResponse(BaseModel):
    execution_id: str
    research: CourseResearchResult
