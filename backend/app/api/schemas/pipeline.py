from pydantic import BaseModel

from app.api.schemas.research import CourseResearchResult, CourseResearchSummary
from app.api.schemas.syllabus import SyllabusGenerateResponse


class CourseResearchPipelineResponse(BaseModel):
    execution_id: str
    research: CourseResearchResult
    summary: CourseResearchSummary
    syllabus: SyllabusGenerateResponse