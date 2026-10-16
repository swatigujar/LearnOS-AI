import json

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class NoteResearchClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_id: str = Field(pattern=r"^claim-\d+$")
    statement: str = Field(min_length=1, max_length=600)
    source_urls: list[HttpUrl] = Field(min_length=1, max_length=4)


class NoteResearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verified_claims: list[NoteResearchClaim] = Field(min_length=1, max_length=12)
    unresolved_gaps: list[str] = Field(default_factory=list, max_length=8)


class NoteSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    heading: str = Field(min_length=1, max_length=100)
    explanation: str = Field(default="", max_length=1800)
    bullets: list[str] = Field(default_factory=list, max_length=8)
    formula: str = Field(default="", max_length=500)
    code: str = Field(default="", max_length=2200)
    code_language: str = Field(default="", max_length=40)
    worked_example: str = Field(default="", max_length=1400)
    source_refs: list[int] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def require_section_content(self):
        if not any((self.explanation.strip(), self.bullets, self.formula.strip(), self.code.strip(), self.worked_example.strip())):
            raise ValueError("Each notes section must contain educational content.")
        if any(not bullet.strip() for bullet in self.bullets):
            raise ValueError("Notes bullets cannot be empty.")
        if any(reference < 0 for reference in self.source_refs):
            raise ValueError("Notes citations cannot use negative indexes.")
        return self


class NotesCoverageItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    objective: str = Field(min_length=1, max_length=600)
    covered: bool
    evidence: str = Field(min_length=1, max_length=500)


class GeneratedNotes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=240)
    subject_type: str = Field(min_length=1, max_length=80)
    summary: str = Field(min_length=1, max_length=1200)
    sections: list[NoteSection] = Field(min_length=1, max_length=8)
    coverage_checklist: list[NotesCoverageItem] = Field(min_length=1, max_length=8)
    common_mistakes: list[str] = Field(default_factory=list, max_length=6)
    quick_review: list[str] = Field(min_length=1, max_length=8)
    unresolved_gaps: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_size_and_coverage(self):
        if any(not item.covered for item in self.coverage_checklist):
            raise ValueError("Notes must cover every supplied learning objective.")
        if len(json.dumps(self.model_dump(), ensure_ascii=False).encode("utf-8")) > 32_000:
            raise ValueError("Generated notes are too large to save safely.")
        return self


class NotesRetryResponse(BaseModel):
    courseId: str
    topicId: str
    status: str


class NotesDeleteResponse(BaseModel):
    courseId: str
    deletedNotes: int
