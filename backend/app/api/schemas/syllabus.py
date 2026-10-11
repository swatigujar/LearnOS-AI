from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from app.api.schemas.research import CourseResearchSummary


class CourseSyllabusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courseId: str = Field(min_length=1, max_length=150, pattern=r"^[^/]+$")
    executionId: str | None = Field(default=None, min_length=1, max_length=64)
    researchSummary: CourseResearchSummary | None = None


class SyllabusGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str = Field(min_length=1, max_length=150)
    course_name: str = Field(min_length=1, max_length=200)
    learning_goal: str = Field(min_length=1, max_length=2000)
    skill_level: Literal["beginner", "intermediate", "advanced"]
    timeline_days: int = Field(gt=0, le=3650)
    study_hours_per_day: float = Field(gt=0, le=24)
    learning_preferences: list[str] | None = Field(default=None, max_length=12)
    additional_requirements: str | None = Field(default=None, max_length=4000)


class SyllabusSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    url: HttpUrl
    source_type: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=1000)


class SyllabusTopic(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic_id: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(min_length=1, max_length=1000)
    estimated_minutes: float = Field(gt=0, allow_inf_nan=False)


class SyllabusModule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(min_length=1, max_length=2000)
    estimated_hours: float = Field(gt=0, allow_inf_nan=False)
    topics: list[SyllabusTopic] = Field(min_length=1, max_length=12)


class GeneratedSyllabus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overview: str = Field(min_length=1, max_length=2000)
    objective: str = Field(min_length=1, max_length=2000)
    duration_days: int = Field(gt=0)
    total_study_hours: float = Field(gt=0, allow_inf_nan=False)
    prerequisites: list[str] = Field(max_length=24)
    modules: list[SyllabusModule] = Field(min_length=1, max_length=24)
    resources: list[SyllabusSource] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def validate_hour_totals(self):
        module_total = sum(module.estimated_hours for module in self.modules)
        tolerance = 0.01
        if abs(module_total - self.total_study_hours) > tolerance:
            raise ValueError("Module estimates must add up to total_study_hours.")

        topic_ids = set()
        for index, module in enumerate(self.modules, start=1):
            if module.module_id != f"module-{index}":
                raise ValueError("Modules must have sequential IDs in learning order: module-1, module-2, ...")
            for topic_index, topic in enumerate(module.topics, start=1):
                if topic.topic_id != f"module-{index}-topic-{topic_index}" or topic.topic_id in topic_ids:
                    raise ValueError("Topics must have sequential, unique IDs in learning order.")
                topic_ids.add(topic.topic_id)
            topic_total = sum(topic.estimated_minutes for topic in module.topics) / 60
            if abs(topic_total - module.estimated_hours) > tolerance:
                raise ValueError("Topic estimates must add up to their module estimate.")
        return self


class SyllabusGenerateResponse(BaseModel):
    courseId: str
    syllabusId: str
    status: Literal["ready"] = "ready"
    syllabusVersion: int = Field(gt=0)
    syllabus: GeneratedSyllabus