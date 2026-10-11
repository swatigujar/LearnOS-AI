import json
import os
from datetime import datetime, timezone
from logging import Formatter, INFO, StreamHandler, getLogger
from time import perf_counter
from uuid import uuid4

from pydantic import ValidationError

from app.api.schemas.research import (
    CourseResearchSummary,
    CourseResearchRequest,
    CourseResearchResult,
    ResearchSource,
)
from app.core.config import GEMINI_MODEL
from app.services.ai_provider import AIProviderError, GeminiProvider

logger = getLogger("learnos.research")
logger.setLevel(INFO)
if not logger.handlers:
    handler = StreamHandler()
    handler.setFormatter(Formatter("%(message)s"))
    logger.addHandler(handler)
logger.propagate = False

INPUT_PRICE_PER_MILLION_USD = 0.75
OUTPUT_PRICE_PER_MILLION_USD = 3.75
SEARCH_PRICE_PER_THOUSAND_USD = 14.0
# TEMP TEST MODE: use direct Gemini research instead of Google Search.
# Restore Google Search after staged pipeline verification.
TEMP_DIRECT_GEMINI_RESEARCH = True


def _research_prompt(request: CourseResearchRequest) -> str:
    learner_inputs = request.model_dump(mode="json", exclude={"courseId"})
    return (
        "Research this learner's requested course and return research only; do not draft or generate a syllabus.\n"
        "Understand the desired outcome, current skill level, available daily study hours, requested timeline, "
        "learning style, and additional requirements from the exact learner inputs below. Identify the most "
        "important concepts and topics needed to achieve the goal, prerequisites, and a logical learning order. "
        "Prefer trustworthy sources such as official documentation, educational institutions, government or "
        "standards bodies, and reputable educational organizations. Include source titles and exact URLs from "
        "the search results. Do not invent sources or URLs. Return only JSON matching the requested structure.\n"
        f"Learner inputs: {json.dumps(learner_inputs, ensure_ascii=True)}"
    )


def _direct_research_prompt(request: CourseResearchRequest) -> str:
    learner_inputs = request.model_dump(mode="json", exclude={"courseId"})
    return (
        "Analyze this learner's goal directly. Do not use web search and do not draft a syllabus. "
        "Identify important topics, key concepts, prerequisites, logical learning order, important "
        "subtopics, and topics required to achieve the learner's desired outcome. Suggest reliable "
        "learning resources only when confident; never invent titles or URLs. Return only JSON matching "
        "the requested schema.\n"
        f"Learner inputs: {json.dumps(learner_inputs, ensure_ascii=True)}"
    )


def _provider_metrics(result, *, no_search: bool = False):
    usage = result.usage
    input_tokens = usage.get("total_input_tokens") if usage else None
    output_tokens = usage.get("total_output_tokens") if usage else None
    total_tokens = usage.get("total_tokens") if usage else None

    search_queries = [] if no_search else result.search_queries
    search_query_count = 0 if no_search else result.search_query_count
    if search_query_count is None and search_queries is not None:
        search_query_count = len(search_queries)
    estimated_cost_usd = None
    if input_tokens is not None and output_tokens is not None and search_query_count is not None:
        estimated_cost_usd = (
            input_tokens * INPUT_PRICE_PER_MILLION_USD
            + output_tokens * OUTPUT_PRICE_PER_MILLION_USD
        ) / 1_000_000 + search_query_count * SEARCH_PRICE_PER_THOUSAND_USD / 1000
        estimated_cost_usd = round(estimated_cost_usd, 8)

    exchange_rate = os.getenv("USD_TO_INR_RATE")
    try:
        estimated_cost_inr = estimated_cost_usd * float(exchange_rate) if estimated_cost_usd is not None and exchange_rate else None
    except ValueError:
        estimated_cost_inr = None

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "search_query_count": search_query_count,
        "search_queries": search_queries,
        "estimated_cost_usd": estimated_cost_usd,
        "estimated_cost_inr": estimated_cost_inr,
    }


def _log_execution(record: dict) -> None:
    logger.info(json.dumps(record, ensure_ascii=True, separators=(",", ":")))
    duration_seconds = record["duration_ms"] / 1000
    tokens = record["total_tokens"]
    token_display = str(tokens) if tokens is not None else "unavailable"
    cost_display = (
        f"${record['estimated_cost_usd']:.8f}"
        if record["estimated_cost_usd"] is not None
        else "unavailable"
    )
    logger.info("\n".join((
        f"EXECUTION: {record['execution_id']}",
        "----------------------------------------",
        "Stage              Status   Time    Tokens   Cost",
        f"{'Syllabus' if record['stage'] == 'syllabus_generation' else 'Web Research':<19}{record['status'].upper():<8} "
        f"{duration_seconds:.1f}s  {token_display:<8} {cost_display}",
        f"Model:             {record['model']}",
        f"Started at:        {record['started_at']}",
        f"Completed at:      {record['completed_at']}",
        f"Input tokens:      {record['input_tokens'] if record['input_tokens'] is not None else 'unavailable'}",
        f"Output tokens:     {record['output_tokens'] if record['output_tokens'] is not None else 'unavailable'}",
        f"Total tokens:      {token_display}",
        f"Search query count: {record['search_query_count'] if record['search_query_count'] is not None else 'unavailable'}",
        f"Search queries:    {json.dumps(record['search_queries'], ensure_ascii=True) if record['search_queries'] is not None else 'unavailable'}",
        f"Estimated USD:     {cost_display}",
        f"Estimated INR:     {record['estimated_cost_inr'] if record['estimated_cost_inr'] is not None else 'unavailable'}",
        f"Error code:        {record['error_code'] if record['error_code'] is not None else 'none'}",
        f"Error message:     {record['error_message'] if record['error_message'] is not None else 'none'}",
        "----------------------------------------",
    )))


def log_gemini_stage(
    execution_id: str,
    stage: str,
    started_at: datetime,
    timer_started: float,
    *,
    result=None,
    error: Exception | None = None,
    no_search: bool = False,
) -> dict:
    record = {
        "execution_id": execution_id,
        "stage": stage,
        "status": "failed" if error else "success",
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((perf_counter() - timer_started) * 1000),
        "model": GEMINI_MODEL,
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "search_query_count": 0 if no_search else None,
        "search_queries": [] if no_search else None,
        "estimated_cost_usd": None,
        "estimated_cost_inr": None,
        "error_code": None,
        "error_message": None,
    }
    if result is not None:
        record.update(_provider_metrics(result, no_search=no_search))
    if error is not None:
        record["error_code"] = getattr(error, "status_code", None) or type(error).__name__
        record["error_message"] = str(error)
    _log_execution(record)
    return record


def research_course(request: CourseResearchRequest) -> tuple[str, CourseResearchResult]:
    execution_id = uuid4().hex
    started_at = datetime.now(timezone.utc)
    timer_started = perf_counter()
    record = {
        "execution_id": execution_id,
        "stage": "web_research",
        "status": "failed",
        "started_at": started_at.isoformat(),
        "completed_at": None,
        "duration_ms": None,
        "model": GEMINI_MODEL,
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "search_query_count": 0 if TEMP_DIRECT_GEMINI_RESEARCH else None,
        "search_queries": [] if TEMP_DIRECT_GEMINI_RESEARCH else None,
        "estimated_cost_usd": None,
        "estimated_cost_inr": None,
        "error_code": None,
        "error_message": None,
    }

    try:
        provider = GeminiProvider()
        if TEMP_DIRECT_GEMINI_RESEARCH:
            prompt = _direct_research_prompt(request)
            provider_result = provider.research_structured_direct(
                prompt, CourseResearchResult.model_json_schema()
            )
        else:
            prompt = _research_prompt(request)
            provider_result = provider.research_structured(
                prompt, CourseResearchResult.model_json_schema()
            )
        record.update(_provider_metrics(provider_result))
        if TEMP_DIRECT_GEMINI_RESEARCH:
            record["search_query_count"] = 0
            record["search_queries"] = []
        research = CourseResearchResult.model_validate_json(provider_result.text)
        sources = list(research.sources)
        known_urls = {str(source.url) for source in sources}
        for source in provider_result.sources:
            if str(source.url) not in known_urls:
                sources.append(ResearchSource(title=source.title, url=source.url))
                known_urls.add(str(source.url))
        research.sources = sources
        record["status"] = "success"
    except (AIProviderError, ValidationError, ValueError, TypeError) as exc:
        record["error_code"] = getattr(exc, "status_code", None) or type(exc).__name__
        record["error_message"] = str(exc) if isinstance(exc, AIProviderError) else "Gemini returned invalid research data."
        raise
    except Exception as exc:
        record["error_code"] = type(exc).__name__
        record["error_message"] = "Gemini web research failed."
        raise AIProviderError("gemini", "Course research failed; no syllabus was generated.") from exc
    finally:
        record["completed_at"] = datetime.now(timezone.utc).isoformat()
        record["duration_ms"] = round((perf_counter() - timer_started) * 1000)
        _log_execution(record)

    return execution_id, research


def summarize_research(
    execution_id: str,
    request: CourseResearchRequest,
    research: CourseResearchResult,
) -> CourseResearchSummary:
    started_at = datetime.now(timezone.utc)
    timer_started = perf_counter()
    provider_result = None
    error = None
    learner_context = request.model_dump(mode="json", exclude={"courseId"})
    prompt = (
        "Summarize the supplied research into a concise, ordered learning map for the learner. "
        "Preserve the desired outcome, prerequisites, important topics, key concepts, and subtopics. "
        "Keep resource suggestions only when supported by the research; do not invent URLs. Do not "
        "generate a syllabus or change the learner's requirements. Return only JSON matching the schema.\n"
        f"Learner inputs: {json.dumps(learner_context, ensure_ascii=True)}\n"
        f"Research: {research.model_dump_json()}"
    )
    try:
        provider_result = GeminiProvider().generate_structured(
            prompt, CourseResearchSummary.model_json_schema()
        )
        return CourseResearchSummary.model_validate_json(provider_result.text)
    except Exception as exc:
        error = exc
        raise
    finally:
        log_gemini_stage(
            execution_id,
            "research_summarization",
            started_at,
            timer_started,
            result=provider_result,
            error=error,
            no_search=True,
        )
