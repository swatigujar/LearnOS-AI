import json
from datetime import datetime, timezone
from time import perf_counter
from uuid import uuid4

from pydantic import ValidationError

from app.api.schemas.research import CourseResearchSummary
from app.api.schemas.syllabus import (
    GeneratedSyllabus,
    SyllabusGenerateRequest,
    SyllabusSource,
)
from app.services.ai_provider import AIProviderError, get_ai_provider
from app.services.course_research import log_gemini_stage


class SyllabusGenerationError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _build_prompt(
    request: SyllabusGenerateRequest,
    research_summary: CourseResearchSummary | None = None,
) -> str:
    learner_context = {
        "course_name": request.course_name,
        "learning_goal": request.learning_goal,
        "skill_level": request.skill_level,
        "timeline_days": request.timeline_days,
        "study_hours_per_day": request.study_hours_per_day,
        "maximum_available_study_hours": request.timeline_days * request.study_hours_per_day,
        "learning_preferences": request.learning_preferences or [],
        "additional_requirements": request.additional_requirements or "",
    }
    prompt = (
        "Create a goal-specific curriculum, not a generic template. Treat course_name as the subject and learning_goal as the "
        "outcome the learner should be able to demonstrate. Use skill_level to choose difficulty: assume no subject knowledge "
        "for beginners; consolidate and apply core skills for intermediate learners; emphasize complex, independent application "
        "for advanced learners. Retain goal prerequisites and do not infer unreported experience. "
        "Use learning_preferences to shape topic activities: visual means diagrams, auditory means discussion or listening, "
        "reading-writing means reading and written summaries, hands-on means applied practice, and mixed or no preference means "
        "vary suitable formats. Apply additional_requirements "
        "where they fit the goal and available time; briefly state a material constraint or trade-off in objective. "
        "Use timeline_days and study_hours_per_day as a capacity limit, not a requirement to fill every available hour. Set "
        "duration_days to timeline_days and keep total estimated work within maximum_available_study_hours. Allocate realistic "
        "time by topic difficulty, including relevant instruction, practice, and review; do not pad estimates. "
        "Use only existing fields: overview is a short descriptive course title; objective is a concise, measurable statement "
        "of what the learner can do or produce. List only entry prerequisites in prerequisites. Order modules and topics so "
        "foundations precede dependent concepts; explain useful dependencies in existing descriptions because there are no "
        "topic-prerequisite fields. Give each module a clear purpose and each topic an actionable title, key concepts, "
        "an observable learner action, and a relevant practical activity. Put concepts in short semicolon-separated phrases in the "
        "topic description. Avoid generic headings and repeated content; include projects or assessment only when useful to the goal. "
        "Keep objective within 40 words, module descriptions within 25, topic descriptions within 40, and resource descriptions "
        "within 20. Do not write lesson content or worked exercises. Retain essential foundations while adapting scope and "
        "proficiency to the time budget; when the goal exceeds it, state achievable scope and remaining progression without "
        "promising mastery. "
        "Return compact JSON only, with exactly the existing fields, types, and collection limits; do not add fields or Markdown. "
        "Use sequential IDs: module-1, module-2, ... and module-1-topic-1, module-1-topic-2, ... . Each module's estimated_hours "
        "must equal its topic minutes divided by 60; module hours must sum to total_study_hours, and all estimates must fit "
        "the available-hours limit. Avoid filling arrays to their maximum. "
        "Prefer authoritative resources and canonical URLs you know with reasonable confidence. Do not invent sources or claim "
        "live research; omit uncertain resources, and never fabricate one to meet the schema's minimum. "
        "Learner context:\n"
        f"{json.dumps(learner_context, ensure_ascii=True)}"
    )
    if research_summary is not None:
        prompt += "\nResearch summary to use as curriculum context:\n"
        prompt += research_summary.model_dump_json()
    return prompt


def validate_syllabus_for_request(
    syllabus: GeneratedSyllabus,
    request: SyllabusGenerateRequest,
) -> GeneratedSyllabus:
    if syllabus.duration_days != request.timeline_days:
        raise SyllabusGenerationError("Syllabus duration does not match the requested timeline.")

    available_hours = request.timeline_days * request.study_hours_per_day
    estimated_hours = max(
        syllabus.total_study_hours,
        sum(module.estimated_hours for module in syllabus.modules),
        sum(topic.estimated_minutes for module in syllabus.modules for topic in module.topics) / 60,
    )
    if estimated_hours > available_hours + 0.000001:
        raise SyllabusGenerationError("Syllabus exceeds the available study-time budget.")
    if not syllabus.modules or not syllabus.resources:
        raise SyllabusGenerationError("Syllabus is missing modules or source references.")
    return syllabus


def generate_syllabus(
    request: SyllabusGenerateRequest,
    execution_id: str | None = None,
    research_summary: CourseResearchSummary | None = None,
) -> GeneratedSyllabus:
    execution_id = execution_id or uuid4().hex
    started_at = datetime.now(timezone.utc)
    timer_started = perf_counter()
    result = None
    error = None
    provider_duration_ms = None
    try:
        provider = get_ai_provider()
        prompt = _build_prompt(request, research_summary)
        response_schema = GeneratedSyllabus.model_json_schema()
        provider_started = perf_counter()
        try:
            result = provider.generate_structured(
                prompt,
                response_schema,
                feature="syllabus_generation",
                request_id=execution_id,
            )
        finally:
            provider_duration_ms = round((perf_counter() - provider_started) * 1000)
        syllabus = GeneratedSyllabus.model_validate_json(result.text)
        if result.sources:
            combined_sources: dict[str, SyllabusSource] = {}
            for source in [*result.sources, *syllabus.resources]:
                combined_sources.setdefault(str(source.url), source)
            syllabus = syllabus.model_copy(update={
                "resources": list(combined_sources.values())[:30],
            })
        return validate_syllabus_for_request(syllabus, request)
    except SyllabusGenerationError as exc:
        error = exc
        raise
    except AIProviderError as exc:
        error = exc
        raise SyllabusGenerationError(str(exc), exc.status_code) from exc
    except (ValidationError, ValueError, TypeError) as exc:
        error = exc
        raise SyllabusGenerationError("The AI provider returned invalid syllabus data.") from exc
    except Exception as exc:
        error = exc
        raise SyllabusGenerationError("Syllabus generation failed.") from exc
    finally:
        if execution_id:
            log_gemini_stage(
                execution_id,
                "syllabus_generation",
                started_at,
                timer_started,
                result=result,
                error=error,
                no_search=True,
                provider_duration_ms=provider_duration_ms,
            )
