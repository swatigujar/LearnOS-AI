import json
import logging
import base64
import binascii
from dataclasses import dataclass
from functools import lru_cache
from time import monotonic
from typing import Protocol
from uuid import uuid4

import httpx
from google import genai
from google.genai import types
from pydantic import ValidationError

from app.core.config import (
    AI_MAX_OUTPUT_TOKENS,
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GEMINI_NOTES_IMAGE_COST_USD,
    GEMINI_NOTES_IMAGE_MODEL,
    GEMINI_NOTES_IMAGE_SIZE,
    GEMINI_SEARCH_PRICE_PER_THOUSAND_USD,
)
from app.api.schemas.syllabus import SyllabusSource
from app.services.ai_usage import UsageLimitError, run_tracked_provider_call


class AIProviderError(Exception):
    def __init__(self, provider: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code


@dataclass
class ProviderResult:
    text: str
    sources: list[SyllabusSource]
    usage: dict | None = None
    search_queries: list[str] | None = None
    search_query_count: int | None = None
    request_id: str | None = None
    image: bytes | None = None


class SyllabusAIProvider(Protocol):
    name: str
    model: str

    def generate_structured(self, prompt: str, schema: dict, *, feature: str = "syllabus_generation",
                            request_id: str | None = None, max_output_tokens: int | None = None) -> ProviderResult: ...

    def test_connection(self) -> ProviderResult: ...


class GeminiProvider:
    name = "gemini"
    model = GEMINI_MODEL

    @lru_cache(maxsize=1)
    def _client(self):
        if not GEMINI_API_KEY:
            raise AIProviderError(self.name, "GEMINI_API_KEY is not configured.")
        client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options=types.HttpOptions(
                timeout=50_000,
                retry_options=types.HttpRetryOptions(attempts=0),
            ),
        )
        client._api_client._http_options.retry_options.attempts = 0
        return client

    @staticmethod
    def _usage_data(metadata) -> dict | None:
        if metadata is None:
            return None

        def read(*names):
            for name in names:
                value = getattr(metadata, name, None)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    return value
            return None

        input_tokens = read("prompt_token_count", "total_input_tokens")
        output_tokens = read("candidates_token_count", "response_token_count", "total_output_tokens")
        thinking_tokens = read("thoughts_token_count", "total_thought_tokens")
        return {
            "total_input_tokens": input_tokens,
            "total_output_tokens": output_tokens,
            "total_thought_tokens": thinking_tokens,
            "total_tokens": read("total_token_count", "total_tokens"),
        }

    def _tracked(self, *, feature, request_id, content, invoke, max_output_tokens=None,
                 reserved_search_count=0, search_price_per_thousand_usd=0.0, fixed_cost_usd=0.0,
                 model=None):
        try:
            return run_tracked_provider_call(
                feature=feature,
                request_id=request_id or uuid4().hex,
                model=model or self.model,
                prompt_content=content,
                invoke=invoke,
                max_output_tokens=max_output_tokens,
                reserved_search_count=reserved_search_count,
                search_price_per_thousand_usd=search_price_per_thousand_usd,
                fixed_cost_usd=fixed_cost_usd,
            )
        except UsageLimitError as exc:
            raise AIProviderError(self.name, str(exc), exc.status_code) from exc

    def generate_structured(self, prompt: str, schema: dict, *, feature: str = "syllabus_generation",
                            request_id: str | None = None, max_output_tokens: int | None = None) -> ProviderResult:
        if not isinstance(AI_MAX_OUTPUT_TOKENS, int) or isinstance(AI_MAX_OUTPUT_TOKENS, bool) or AI_MAX_OUTPUT_TOKENS < 1:
            raise AIProviderError(self.name, "The configured response token limit is invalid.", 503)
        if max_output_tokens is not None and (
            not isinstance(max_output_tokens, int) or isinstance(max_output_tokens, bool) or max_output_tokens < 1
        ):
            raise AIProviderError(self.name, "The structured response token limit is invalid.", 503)
        output_limit = AI_MAX_OUTPUT_TOKENS if max_output_tokens is None else min(AI_MAX_OUTPUT_TOKENS, max_output_tokens)
        content = (
            f"{prompt}\nReturn only a valid JSON object, without Markdown fences or commentary."
            f"\nOutput JSON must satisfy this schema:\n{json.dumps(schema)}"
        )

        def invoke():
            deadline = monotonic() + 120
            try:
                client = self._client()
                remaining_ms = int((deadline - monotonic()) * 1000)
                if remaining_ms <= 0:
                    raise httpx.TimeoutException("Gemini request deadline exceeded.")
                response = client.models.generate_content(
                    model=self.model,
                    contents=content,
                    config=types.GenerateContentConfig(
                        max_output_tokens=output_limit,
                        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
                        http_options=types.HttpOptions(
                            timeout=remaining_ms,
                            retry_options=types.HttpRetryOptions(attempts=0),
                        ),
                    ),
                )
            except httpx.TimeoutException as exc:
                raise AIProviderError(self.name, "Gemini request exceeded its 120-second request deadline.", 504) from exc
            except AIProviderError:
                raise
            except Exception as exc:
                status_code = getattr(exc, "status_code", None)
                if not isinstance(status_code, int):
                    code = getattr(exc, "code", None)
                    status_code = code if isinstance(code, int) else None
                logging.getLogger(__name__).error(
                    "Gemini request failed exception_type=%s status=%s.",
                    type(exc).__name__, status_code,
                )
                detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
                label = {
                    "tutor": "Gemini tutor",
                    "mock_test": "Gemini mock-test question generation",
                }.get(feature, "Gemini syllabus generation")
                raise AIProviderError(self.name, f"{label} failed ({detail}).", status_code) from exc
            text = getattr(response, "text", None)
            usage = self._usage_data(getattr(response, "usage_metadata", None))
            if not text:
                raise AIProviderError(self.name, "Gemini returned no structured response.")
            return ProviderResult(
                text=text,
                sources=[],
                usage=usage,
                request_id=getattr(response, "response_id", None),
            )

        return self._tracked(
            feature=feature, request_id=request_id, content=content, invoke=invoke,
            max_output_tokens=output_limit,
        )

    def count_input_tokens(self, prompt: str) -> int | None:
        def invoke():
            try:
                response = self._client().models.count_tokens(model=self.model, contents=prompt)
            except Exception as exc:
                status_code = getattr(exc, "code", None)
                detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
                raise AIProviderError(self.name, f"Gemini input token count failed ({detail}).", status_code) from exc
            tokens = getattr(response, "total_tokens", None)
            return ProviderResult(
                text="",
                sources=[],
                usage={
                    "total_input_tokens": tokens if isinstance(tokens, int) and tokens >= 0 else None,
                    "total_output_tokens": None,
                    "total_thought_tokens": None,
                    "total_tokens": tokens if isinstance(tokens, int) and tokens >= 0 else None,
                },
            )

        result = self._tracked(
            feature="input_token_count",
            request_id=uuid4().hex,
            content=prompt,
            invoke=invoke,
            max_output_tokens=1,
        )
        return result.usage.get("total_input_tokens") if result.usage else None

    def _research(self, prompt: str, schema: dict | None, *, use_search: bool, feature: str,
                  request_id: str | None) -> ProviderResult:
        format_spec = {"type": "text", "mime_type": "application/json", "schema": schema} if schema else None
        content_for_budget = f"{prompt}\n{json.dumps(format_spec, ensure_ascii=True)}" if format_spec else prompt

        def invoke():
            try:
                request = {
                    "model": self.model,
                    "input": prompt,
                    **({"tools": [{"type": "google_search"}]} if use_search else {}),
                    "generation_config": {
                        "max_output_tokens": AI_MAX_OUTPUT_TOKENS,
                        "thinking_level": "low",
                    },
                }
                if format_spec:
                    request["response_format"] = format_spec
                interaction = self._client().interactions.create(**request)
            except Exception as exc:
                status_code = getattr(exc, "status_code", None)
                if not isinstance(status_code, int):
                    code = getattr(exc, "code", None)
                    status_code = code if isinstance(code, int) else None
                detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
                raise AIProviderError(self.name, f"Gemini research request failed ({detail}).", status_code) from exc
            text = getattr(interaction, "output_text", None)
            usage = getattr(interaction, "usage", None)
            usage_data = usage.model_dump(exclude_none=True) if usage is not None else None
            search_queries = self._extract_search_queries(interaction) if use_search else []
            search_count = len(search_queries) if search_queries else self._extract_search_count(usage) if use_search else 0
            if usage_data is not None:
                usage_data["search_query_count"] = search_count
            if not text:
                raise AIProviderError(self.name, "Gemini returned no research response.")
            return ProviderResult(
                text=text,
                sources=self._extract_grounded_sources(interaction),
                usage=usage_data,
                search_queries=search_queries,
                search_query_count=search_count,
                request_id=getattr(interaction, "id", None),
            )

        return self._tracked(
            feature=feature,
            request_id=request_id,
            content=content_for_budget,
            invoke=invoke,
            reserved_search_count=20 if use_search else 0,
            search_price_per_thousand_usd=GEMINI_SEARCH_PRICE_PER_THOUSAND_USD,
        )

    def research_structured(self, prompt: str, schema: dict, *, feature: str = "course_research",
                            request_id: str | None = None) -> ProviderResult:
        return self._research(prompt, schema, use_search=True, feature=feature, request_id=request_id)

    def research_structured_direct(self, prompt: str, schema: dict, *, feature: str = "course_research",
                                   request_id: str | None = None) -> ProviderResult:
        return self._research(prompt, schema, use_search=False, feature=feature, request_id=request_id)

    def research_grounded_text(self, prompt: str, *, feature: str = "notes_research",
                               request_id: str | None = None) -> ProviderResult:
        """Return a prose search-grounded answer so Gemini includes citation annotations."""
        return self._research(prompt, None, use_search=True, feature=feature, request_id=request_id)

    def generate_handwritten_jpeg(self, prompt: str, *, feature: str, request_id: str) -> bytes:
        """Render validated note text as a private JPEG using the configured image model."""
        model = GEMINI_NOTES_IMAGE_MODEL
        if GEMINI_NOTES_IMAGE_SIZE not in ("1K", "2K", "4K"):
            raise AIProviderError(self.name, "The configured notes image size is invalid.", 503)

        def invoke():
            try:
                interaction = self._client().interactions.create(
                    model=model,
                    input=prompt,
                    response_format={
                        "type": "image", "mime_type": "image/jpeg", "aspect_ratio": "3:4",
                        "image_size": GEMINI_NOTES_IMAGE_SIZE,
                    },
                )
            except Exception as exc:
                status = getattr(exc, "status_code", None)
                if not isinstance(status, int):
                    status = getattr(exc, "code", None)
                logging.getLogger(__name__).error("Gemini notes image failed (%s).", type(exc).__name__)
                raise AIProviderError(self.name, "Gemini handwritten note image generation failed.",
                                      status if isinstance(status, int) else None) from exc
            output = getattr(interaction, "output_image", None)
            encoded = getattr(output, "data", None) if output is not None else None
            if not isinstance(encoded, (str, bytes)):
                raise AIProviderError(self.name, "Gemini returned no notes image.")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise AIProviderError(self.name, "Gemini returned an invalid notes image.") from exc
            if not data.startswith(b"\xff\xd8\xff") or len(data) > 10_000_000:
                raise AIProviderError(self.name, "Gemini returned an invalid or oversized JPEG.")
            usage_obj = getattr(interaction, "usage", None)
            usage = usage_obj.model_dump(exclude_none=True) if usage_obj is not None else None
            return ProviderResult(text="", sources=[], usage=usage,
                                  request_id=getattr(interaction, "id", None), image=data)

        result = self._tracked(
            feature=feature, request_id=request_id, content=prompt, invoke=invoke,
            max_output_tokens=1, fixed_cost_usd=GEMINI_NOTES_IMAGE_COST_USD, model=model,
        )
        if not isinstance(result.image, bytes):
            raise AIProviderError(self.name, "Gemini returned no notes image.")
        return result.image

    def test_connection(self) -> ProviderResult:
        def invoke():
            try:
                response = self._client().models.generate_content(
                    model=self.model,
                    contents="Reply with exactly: ok",
                    config=types.GenerateContentConfig(
                        max_output_tokens=16,
                        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
                        http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=0)),
                    ),
                )
            except Exception as exc:
                raise AIProviderError(self.name, "Gemini connectivity test failed.", getattr(exc, "status_code", None)) from exc
            if not getattr(response, "text", None):
                raise AIProviderError(self.name, "Gemini returned no test response.")
            return ProviderResult(
                text="",
                sources=[],
                usage=self._usage_data(getattr(response, "usage_metadata", None)),
                request_id=getattr(response, "response_id", None),
            )

        return self._tracked(
            feature="ai_connectivity_test",
            request_id=uuid4().hex,
            content="Reply with exactly: ok",
            invoke=invoke,
            max_output_tokens=16,
        )

    @staticmethod
    def _extract_grounded_sources(interaction) -> list[SyllabusSource]:
        sources: list[SyllabusSource] = []
        for step in getattr(interaction, "steps", None) or []:
            for block in getattr(step, "content", None) or []:
                for annotation in getattr(block, "annotations", None) or []:
                    if getattr(annotation, "type", None) != "url_citation":
                        continue
                    url = getattr(annotation, "url", None)
                    title = getattr(annotation, "title", None)
                    if url and title:
                        try:
                            sources.append(SyllabusSource(
                                title=title,
                                url=url,
                                source_type="Google Search grounding",
                                description="Source retrieved through Google Search grounding.",
                            ))
                        except ValidationError:
                            continue
        return sources

    @staticmethod
    def _extract_search_queries(interaction) -> list[str] | None:
        queries = []
        has_query_metadata = False
        for step in getattr(interaction, "steps", None) or []:
            if getattr(step, "type", None) != "google_search_call":
                continue
            arguments = getattr(step, "arguments", None)
            step_queries = getattr(arguments, "queries", None)
            if step_queries is not None:
                has_query_metadata = True
                queries.extend(step_queries)
        return queries if has_query_metadata else None

    @staticmethod
    def _extract_search_count(usage) -> int | None:
        for tool_count in getattr(usage, "grounding_tool_count", None) or []:
            if getattr(tool_count, "type", None) == "google_search":
                return getattr(tool_count, "count", None)
        return None


@lru_cache(maxsize=1)
def get_ai_provider() -> SyllabusAIProvider:
    return GeminiProvider()
