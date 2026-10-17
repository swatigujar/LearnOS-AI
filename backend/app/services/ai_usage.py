"""Transactional request and estimated-cost limits for Gemini calls."""

import hashlib
import logging
import math
from datetime import datetime, timezone
from time import perf_counter
from typing import Callable

from firebase_admin import firestore

from app.core.config import (
    AI_DAILY_REQUEST_LIMIT,
    AI_MAX_OUTPUT_TOKENS,
    AI_MONTHLY_ESTIMATED_COST_LIMIT_USD,
    GEMINI_LIVE_INPUT_AUDIO_PRICE_PER_MILLION_USD,
    GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD,
    GEMINI_LIVE_INPUT_TEXT_PRICE_PER_MILLION_USD,
    GEMINI_LIVE_OUTPUT_AUDIO_PRICE_PER_MILLION_USD,
    GEMINI_LIVE_OUTPUT_TEXT_PRICE_PER_MILLION_USD,
    GEMINI_INPUT_PRICE_PER_MILLION_USD,
    GEMINI_OUTPUT_PRICE_PER_MILLION_USD,
    GEMINI_SEARCH_PRICE_PER_THOUSAND_USD,
    USD_TO_INR_RATE,
)
from app.core.firebase import get_firestore_client

logger = logging.getLogger(__name__)


class UsageLimitError(Exception):
    def __init__(self, message: str, status_code: int = 429):
        super().__init__(message)
        self.status_code = status_code


def _pricing() -> tuple[float, float]:
    try:
        input_rate = float(GEMINI_INPUT_PRICE_PER_MILLION_USD)
        output_rate = float(GEMINI_OUTPUT_PRICE_PER_MILLION_USD)
    except (TypeError, ValueError) as exc:
        raise UsageLimitError("Gemini pricing is not configured; AI requests are disabled.", 503) from exc
    if not all(math.isfinite(value) and value >= 0 for value in (input_rate, output_rate)):
        raise UsageLimitError("Gemini pricing configuration is invalid; AI requests are disabled.", 503)
    return input_rate, output_rate


def estimate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    input_rate, output_rate = _pricing()
    return round((input_tokens * input_rate + output_tokens * output_rate) / 1_000_000, 8)

def _inr_rate():
    try:
        rate = float(USD_TO_INR_RATE)
    except (TypeError, ValueError):
        return None
    return rate if math.isfinite(rate) and rate > 0 else None


def _to_inr(amount_usd):
    rate = _inr_rate()
    if amount_usd is None or rate is None:
        return None
    return round(amount_usd * rate, 8)


def _request_refs(database, feature: str, request_id: str, now: datetime):
    request_key = hashlib.sha256(f"{feature}:{request_id}".encode("utf-8")).hexdigest()
    daily_ref = database.document(f"system/ai_usage/daily/{now:%Y-%m-%d}")
    monthly_ref = database.document(f"system/ai_usage/monthly/{now:%Y-%m}")
    request_ref = database.document(f"system/ai_usage/requests/{request_key}")
    return daily_ref, monthly_ref, request_ref


@firestore.transactional
def _reserve(transaction, daily_ref, monthly_ref, request_ref, record, request_limit, cost_limit):
    request_snapshot = request_ref.get(transaction=transaction)
    if request_snapshot.exists:
        return "duplicate"

    daily_snapshot = daily_ref.get(transaction=transaction)
    monthly_snapshot = monthly_ref.get(transaction=transaction)
    daily_data = daily_snapshot.to_dict() if daily_snapshot.exists else {}
    monthly_data = monthly_snapshot.to_dict() if monthly_snapshot.exists else {}
    current_requests = daily_data.get("request_count") if daily_snapshot.exists else 0
    current_estimated_cost = monthly_data.get("reserved_estimated_cost_usd") if monthly_snapshot.exists else 0.0
    if not isinstance(current_requests, int) or isinstance(current_requests, bool) or current_requests < 0:
        raise UsageLimitError("Gemini usage records need review; AI requests are disabled.", 503)
    if not isinstance(current_estimated_cost, (int, float)) or not math.isfinite(current_estimated_cost) or current_estimated_cost < 0:
        raise UsageLimitError("Gemini cost records need review; AI requests are disabled.", 503)
    # Daily and monthly cap enforcement is temporarily disabled by request.
    # if current_requests >= request_limit:
    #     raise UsageLimitError("The configured daily Gemini request limit has been reached.")
    next_cost = round(float(current_estimated_cost) + record["reserved_estimated_cost_usd"], 8)
    # if next_cost > cost_limit:
    #     raise UsageLimitError("The configured monthly Gemini estimated-cost limit has been reached.")

    transaction.create(request_ref, record)
    transaction.set(daily_ref, {
        "request_count": current_requests + 1,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    transaction.set(monthly_ref, {
        "reserved_estimated_cost_usd": next_cost,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return "reserved"


@firestore.transactional
def _settle(transaction, monthly_ref, request_ref, update):
    request_snapshot = request_ref.get(transaction=transaction)
    if not request_snapshot.exists:
        return False
    existing = request_snapshot.to_dict() or {}
    if existing.get("status") != "reserved":
        return True
    monthly_snapshot = monthly_ref.get(transaction=transaction)
    monthly_data = monthly_snapshot.to_dict() if monthly_snapshot.exists else {}
    current_cost = monthly_data.get("reserved_estimated_cost_usd")
    if not isinstance(current_cost, (int, float)) or not math.isfinite(current_cost) or current_cost < 0:
        raise UsageLimitError("Gemini cost records need review; AI requests are disabled.", 503)

    revised_cost = current_cost
    actual_cost = update.get("estimated_cost_usd")
    if actual_cost is not None:
        revised_cost = round(max(0.0, current_cost - existing["reserved_estimated_cost_usd"]) + actual_cost, 8)
    transaction.set(request_ref, update, merge=True)
    if actual_cost is not None:
        transaction.set(monthly_ref, {
            "reserved_estimated_cost_usd": revised_cost,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
    return True


def _usage_values(result):
    usage = getattr(result, "usage", None)
    if not isinstance(usage, dict):
        return None, None, None, None, None

    def read(*keys):
        for key in keys:
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        return None

    search_count = read("search_query_count")
    if search_count is None:
        search_count = getattr(result, "search_query_count", None)
        if not isinstance(search_count, int) or isinstance(search_count, bool) or search_count < 0:
            search_count = None
    return (
        read("total_input_tokens", "input_tokens", "prompt_token_count"),
        read("total_output_tokens", "output_tokens", "candidates_token_count"),
        read("total_thought_tokens", "thinking_tokens", "thoughts_token_count"),
        read("total_tokens", "total_token_count"),
        search_count,
    )

def _log_usage(*, request_id, feature, model, status, duration_ms, result=None,
               reserved_cost_usd=0.0, reserved_search_count=0, search_price_per_thousand_usd=0.0,
               fixed_cost_usd=0.0, error_code=None):
    input_tokens, output_tokens, thinking_tokens, total_tokens, search_query_count = _usage_values(result)
    try:
        input_rate, output_rate = _pricing()
    except UsageLimitError:
        input_rate = output_rate = None
    input_cost_usd = input_tokens * input_rate / 1_000_000 if input_tokens is not None and input_rate is not None else None
    output_cost_usd = output_tokens * output_rate / 1_000_000 if output_tokens is not None and output_rate is not None else None
    thinking_cost_usd = thinking_tokens * output_rate / 1_000_000 if thinking_tokens is not None and output_rate is not None else None
    search_cost_usd = None
    if reserved_search_count == 0:
        search_cost_usd = 0.0
    elif search_query_count is not None:
        search_cost_usd = search_query_count * search_price_per_thousand_usd / 1000
    usage_available = (
        input_cost_usd is not None and output_cost_usd is not None and thinking_cost_usd is not None
        and search_cost_usd is not None
    )
    estimated_cost_usd = None
    if usage_available:
        estimated_cost_usd = round(
            input_cost_usd + output_cost_usd + thinking_cost_usd + search_cost_usd
            + fixed_cost_usd,
            8,
        )
    logger.info("GEMINI_USAGE %s", {
        "request_id": request_id,
        "feature": feature,
        "model": model,
        "status": status,
        "duration_ms": duration_ms,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "thinking_tokens": thinking_tokens,
        "total_tokens": total_tokens,
        "token_usage_available": input_tokens is not None and output_tokens is not None,
        "input_token_cost_inr_estimate": _to_inr(input_cost_usd),
        "output_token_cost_inr_estimate": _to_inr(output_cost_usd),
        "thinking_token_cost_inr_estimate": _to_inr(thinking_cost_usd),
        "estimated_cost_usd": estimated_cost_usd,
        "estimated_cost_inr": _to_inr(estimated_cost_usd),
        "fixed_cost_inr_estimate": _to_inr(fixed_cost_usd),
        "reserved_estimated_cost_usd": reserved_cost_usd,
        "reserved_estimated_cost_inr": _to_inr(reserved_cost_usd),
        "usd_to_inr_rate": _inr_rate(),
        "error_code": error_code,
    })


def log_live_usage(*, request_id, model, usage, session_reserved_cost_usd):
    input_prices = {
        "TEXT": GEMINI_LIVE_INPUT_TEXT_PRICE_PER_MILLION_USD,
        "AUDIO": GEMINI_LIVE_INPUT_AUDIO_PRICE_PER_MILLION_USD,
        "IMAGE": GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD,
        "VIDEO": GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD,
        "DOCUMENT": GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD,
    }
    output_prices = {
        "TEXT": GEMINI_LIVE_OUTPUT_TEXT_PRICE_PER_MILLION_USD,
        "AUDIO": GEMINI_LIVE_OUTPUT_AUDIO_PRICE_PER_MILLION_USD,
    }

    def modality_cost(details, prices, token_count):
        if not details:
            return 0.0 if token_count == 0 else None
        total = 0.0
        for detail in details:
            price = prices.get(detail["modality"])
            if price is None:
                return None
            total += detail["token_count"] * price / 1_000_000
        return total

    input_cost_usd = modality_cost(
        usage["prompt_tokens_details"], input_prices, usage.get("input_tokens"),
    )
    response_cost_usd = modality_cost(
        usage["response_tokens_details"], output_prices, usage.get("output_tokens"),
    )
    thinking_tokens = usage.get("thinking_tokens")
    thinking_cost_usd = (
        thinking_tokens * GEMINI_LIVE_OUTPUT_TEXT_PRICE_PER_MILLION_USD / 1_000_000
        if thinking_tokens is not None else None
    )
    estimated_cost_usd = None
    if input_cost_usd is not None and response_cost_usd is not None and thinking_cost_usd is not None:
        estimated_cost_usd = round(input_cost_usd + response_cost_usd + thinking_cost_usd, 8)
    logger.info("GEMINI_LIVE_USAGE %s", {
        "request_id": request_id,
        "model": model,
        "source": "client_reported_provider_usage",
        "usage_scope": "provider_snapshot",
        "token_usage_available": usage.get("input_tokens") is not None and usage.get("output_tokens") is not None,
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "thinking_tokens": thinking_tokens,
        "total_tokens": usage.get("total_tokens"),
        "input_token_cost_inr_estimate": _to_inr(input_cost_usd),
        "output_token_cost_inr_estimate": _to_inr(response_cost_usd),
        "thinking_token_cost_inr_estimate": _to_inr(thinking_cost_usd),
        "estimated_token_cost_inr": _to_inr(estimated_cost_usd),
        "session_reserved_cost_inr": _to_inr(session_reserved_cost_usd),
        "usd_to_inr_rate": _inr_rate(),
    })


def _settle_record(database, refs, *, status, result=None, error_code=None, reserved_search_count=0,
                   fixed_cost_usd=0.0, known_unbilled=False):
    _, monthly_ref, request_ref = refs
    input_tokens, output_tokens, thinking_tokens, total_tokens, search_query_count = _usage_values(result)
    actual_cost = None
    search_count = search_query_count
    # A missing tool count is not treated as zero; retain the pre-call reserve.
    if (input_tokens is not None and output_tokens is not None and thinking_tokens is not None
            and (reserved_search_count == 0 or search_count is not None)):
        actual_cost = estimate_cost_usd(input_tokens, output_tokens + thinking_tokens) + fixed_cost_usd
        if search_count is not None:
            actual_cost += search_count * GEMINI_SEARCH_PRICE_PER_THOUSAND_USD / 1000
            actual_cost = round(actual_cost, 8)
    if known_unbilled:
        actual_cost = 0.0
    provider_request_id = getattr(result, "request_id", None) if result is not None else None
    if not isinstance(provider_request_id, str) or len(provider_request_id) > 256:
        provider_request_id = None
    update = {
        "status": status,
        "provider_request_id": provider_request_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "thinking_tokens": thinking_tokens,
        "total_tokens": total_tokens,
        "search_query_count": search_query_count,
        "usage_metadata_available": (
            input_tokens is not None and output_tokens is not None and thinking_tokens is not None
            and (reserved_search_count == 0 or search_count is not None)
        ),
        "estimated_cost_usd": actual_cost,
        "error_code": error_code if isinstance(error_code, (int, str)) else None,
        "completed_at": firestore.SERVER_TIMESTAMP,
    }
    _settle(database.transaction(), monthly_ref, request_ref, update)


def run_tracked_provider_call(
    *,
    feature: str,
    request_id: str,
    model: str,
    prompt_content: str,
    invoke: Callable,
    max_output_tokens: int | None = None,
    reserved_search_count: int = 0,
    search_price_per_thousand_usd: float = 0.0,
    fixed_cost_usd: float = 0.0,
):
    """Reserve budget before invoking Gemini, then settle from returned metadata."""
    if not request_id or len(request_id) > 160:
        raise UsageLimitError("A valid Gemini request identifier is required.", 503)
    # if AI_DAILY_REQUEST_LIMIT <= 0 or not math.isfinite(AI_MONTHLY_ESTIMATED_COST_LIMIT_USD) or AI_MONTHLY_ESTIMATED_COST_LIMIT_USD <= 0:
    #     raise UsageLimitError("Gemini request limits are invalid; AI requests are disabled.", 503)
    output_cap = AI_MAX_OUTPUT_TOKENS if max_output_tokens is None else max_output_tokens
    if not isinstance(output_cap, int) or isinstance(output_cap, bool) or output_cap < 1:
        raise UsageLimitError("Gemini output-token limit is invalid; AI requests are disabled.", 503)
    if not isinstance(reserved_search_count, int) or reserved_search_count < 0:
        raise UsageLimitError("Gemini research budget is invalid; AI requests are disabled.", 503)
    if (not isinstance(search_price_per_thousand_usd, (int, float))
            or not math.isfinite(search_price_per_thousand_usd) or search_price_per_thousand_usd < 0):
        raise UsageLimitError("Gemini search pricing is invalid; AI requests are disabled.", 503)
    if not isinstance(fixed_cost_usd, (int, float)) or not math.isfinite(fixed_cost_usd) or fixed_cost_usd < 0:
        raise UsageLimitError("Gemini fixed cost is invalid; AI requests are disabled.", 503)
    # UTF-8 bytes conservatively bound text input tokens. Double the output cap
    # to reserve room for thinking tokens in addition to visible response text.
    reserved_input_tokens = len(prompt_content.encode("utf-8"))
    reserved_output_tokens = output_cap * 2
    reserved_cost = round(
        estimate_cost_usd(reserved_input_tokens, reserved_output_tokens)
        + reserved_search_count * search_price_per_thousand_usd / 1000,
        8,
    ) + fixed_cost_usd
    now = datetime.now(timezone.utc)
    try:
        database = get_firestore_client()
    except Exception as exc:
        logger.error("Gemini usage database is unavailable (%s).", type(exc).__name__)
        raise UsageLimitError("Gemini usage limits are unavailable; AI requests are disabled.", 503) from exc
    refs = _request_refs(database, feature, request_id, now)
    daily_ref, monthly_ref, request_ref = refs
    record = {
        # Keep the stable local ID opaque because some internal callers accept
        # client-supplied idempotency identifiers.
        "request_id": request_ref.id,
        "feature": feature,
        "model": model,
        "status": "reserved",
        "reserved_input_token_estimate": reserved_input_tokens,
        "reserved_output_token_limit": output_cap,
        "reserved_estimated_cost_usd": reserved_cost,
        "reserved_search_count": reserved_search_count,
        "reserved_fixed_cost_usd": fixed_cost_usd,
        "requested_at": firestore.SERVER_TIMESTAMP,
    }
    try:
        reservation = _reserve(database.transaction(), daily_ref, monthly_ref, request_ref, record,
                               AI_DAILY_REQUEST_LIMIT, AI_MONTHLY_ESTIMATED_COST_LIMIT_USD)
    except UsageLimitError:
        raise
    except Exception as exc:
        logger.error("Gemini usage reservation failed (%s).", type(exc).__name__)
        raise UsageLimitError("Gemini usage limits are unavailable; AI requests are disabled.", 503) from exc
    if reservation == "duplicate":
        raise UsageLimitError("This Gemini request was already submitted; duplicate execution was blocked.", 409)

    started = perf_counter()
    try:
        result = invoke()
    except Exception as exc:
        code = getattr(exc, "status_code", None)
        if not isinstance(code, int):
            code = type(exc).__name__
        try:
            _settle_record(database, refs, status="failed", error_code=code,
                           reserved_search_count=reserved_search_count, fixed_cost_usd=fixed_cost_usd,
                           known_unbilled=(feature == "tutor_live_session"
                                           and code in (400, 401, 403, 404, 422, 429)))
        except Exception as settle_error:
            logger.error("Gemini failure usage settlement failed (%s).", type(settle_error).__name__)
        _log_usage(
            request_id=request_ref.id, feature=feature, model=model, status="failed",
            duration_ms=round((perf_counter() - started) * 1000), reserved_cost_usd=reserved_cost,
            reserved_search_count=reserved_search_count,
            search_price_per_thousand_usd=search_price_per_thousand_usd,
            fixed_cost_usd=fixed_cost_usd, error_code=code,
        )
        raise
    try:
        _settle_record(database, refs, status="success", result=result,
                       reserved_search_count=reserved_search_count, fixed_cost_usd=fixed_cost_usd)
    except Exception as exc:
        # Keep the full reservation in the monthly budget if usage could not be
        # recorded, and return the already-generated result to avoid a duplicate call.
        logger.error("Gemini success usage settlement failed (%s).", type(exc).__name__)
    _log_usage(
        request_id=request_ref.id, feature=feature, model=model, status="success",
        duration_ms=round((perf_counter() - started) * 1000), result=result,
        reserved_cost_usd=reserved_cost, reserved_search_count=reserved_search_count,
        search_price_per_thousand_usd=search_price_per_thousand_usd,
        fixed_cost_usd=fixed_cost_usd,
    )
    return result
