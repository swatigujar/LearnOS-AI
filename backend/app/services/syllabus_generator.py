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
        "Create a complete, personalized curriculum using subject-specific reasoning, not a fixed template or generic topic list. "
        "Identify the subject, intended outcome, current level, goal-appropriate target proficiency, timeline, daily study hours, "
        "learning preferences, and additional requirements from the learner context. "
        "Internally identify the essential knowledge areas, core concepts, subtopics, practical skills, and prerequisites "
        "needed for the goal. Cover foundations before intermediate and advanced applications as appropriate; "
        "do not omit essential topics merely to shorten the syllabus. For absolute beginners, assume no subject knowledge. "
        "Prioritize the hierarchy course -> modules -> topics -> concepts, not introductory prose. "
        "There is no course-title field: use overview for a short, descriptive course title only and objective for concise "
        "measurable outcomes, followed by prerequisites, ordered modules, and teachable topics within each module. "
        "Do not put the curriculum into overview or a single paragraph; avoid marketing summaries and long introductions. "
        "Keep objective within 40 words, module descriptions within 25 words, topic descriptions within 40 words, "
        "and resource descriptions within 20 words. Use compact JSON without indentation. "
        "Remove repeated explanations, not essential topics or concepts; do not fill arrays to their schema maximum. "
        "Give each module a clear title and short coverage description, and each topic an actionable title and concise "
        "description of its exact concepts and learning objective, with realistic estimated_hours or estimated_minutes respectively. "
        "Avoid titles such as Introduction, Overview, or Advanced Concepts unless they name the actual concepts taught. "
        "Each topic must prepare the learner for later topics. There are no subtopic fields: organize essential concepts "
        "and skills as short, semicolon-separated items within each topic description, not unsupported JSON fields. "
        "Within existing descriptions, include concise plans for relevant examples, "
        "hands-on practice, revision, projects, and assessments. Include their time in the topic estimates; "
        "do not write full lesson content, worked exercises, or add unsupported fields. "
        "Adapt depth, complexity, and achievable proficiency to the time budget while retaining essential foundations. "
        "If the goal exceeds that budget, briefly state the achievable scope and remaining progression in objective; "
        "do not promise expert mastery from a short course. "
        "Before returning, internally review for missing foundations, important subtopics, prerequisite gaps, practical "
        "application, alignment with the final goal, and unnecessary repetition. Add missing essentials within schema limits. "
        "Return only the requested structured JSON with exactly the existing fields, types, and collection/string limits; "
        "no Markdown or explanatory prose outside the JSON. "
        "Use module IDs module-1, module-2, ... and topic IDs module-1-topic-1, module-1-topic-2, ... in order. "
        "The total and module/topic hour estimates must fit within maximum_available_study_hours; "
        "each module's estimated_hours must equal the sum of its topics' estimated_minutes divided by 60, "
        "and module hours must sum to total_study_hours. Set duration_days to timeline_days. "
        "Prefer official documentation, standards, and authoritative learning resources appropriate to the subject. "
        "Include only resources and canonical URLs you can identify with reasonable confidence; never invent citations, "
        "resources, or URLs or claim live web research was performed. Omit uncertain resources, not required fields; "
        "the existing schema requires at least one reliable resource, so never fabricate one to satisfy that minimum. "
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
    try:
        result = get_ai_provider().generate_structured(
            _build_prompt(request, research_summary),
            GeneratedSyllabus.model_json_schema(),
        )
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
            )