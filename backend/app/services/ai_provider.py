import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from time import monotonic
from typing import Protocol

import httpx
from google import genai
from google.genai import types
from pydantic import ValidationError

from app.core.config import GEMINI_API_KEY, GEMINI_MODEL
from app.api.schemas.syllabus import SyllabusSource


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


class SyllabusAIProvider(Protocol):
    name: str
    model: str

    def generate_structured(self, prompt: str, schema: dict) -> ProviderResult: ...

    def test_connection(self) -> None: ...


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

    def generate_structured(self, prompt: str, schema: dict) -> ProviderResult:
        deadline = monotonic() + 120
        try:
            client = self._client()
            remaining_ms = int((deadline - monotonic()) * 1000)
            if remaining_ms <= 0:
                raise httpx.TimeoutException("Syllabus request deadline exceeded.")
            response = client.models.generate_content(
                model=self.model,
                contents=(
                    f"{prompt}\nReturn only a valid JSON object, without Markdown fences or commentary."
                    f"\nOutput JSON must satisfy this schema:\n{json.dumps(schema)}"
                ),
                config=types.GenerateContentConfig(http_options=types.HttpOptions(
                    timeout=remaining_ms,
                    retry_options=types.HttpRetryOptions(attempts=0),
                )),
            )
        except httpx.TimeoutException as exc:
            raise AIProviderError(self.name, "Gemini syllabus generation exceeded its 120-second request deadline.") from exc
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if not isinstance(status_code, int):
                code = getattr(exc, "code", None)
                status_code = code if isinstance(code, int) else None
            try:
                def redact(value):
                    if isinstance(value, dict):
                        return {
                            key: "[REDACTED]" if re.search(
                                r"key|authorization|headers|request|input|contents|prompt|schema",
                                key, re.IGNORECASE,
                            ) else redact(item)
                            for key, item in value.items()
                        }
                    if isinstance(value, list):
                        return [redact(item) for item in value]
                    if isinstance(value, str):
                        for sensitive in (GEMINI_API_KEY, prompt, json.dumps(schema)):
                            if sensitive:
                                value = value.replace(sensitive, "[REDACTED]")
                                value = value.replace(json.dumps(sensitive)[1:-1], "[REDACTED]")
                        return re.sub(
                            r"(?i)(bearer\s+\S+|AIza[\w-]+|(?:authorization|x-goog-api-key|api[_-]?key|key)\s*[:=]\s*[^\s,;]+)",
                            "[REDACTED]", value,
                        )
                    return value

                response = getattr(exc, "raw_response", None)
                if response is None:
                    response = getattr(exc, "response", None)
                body = getattr(exc, "body", None)
                if body is None and response is not None:
                    body = response.text
                if isinstance(body, str):
                    try:
                        body = json.loads(body)
                    except ValueError:
                        pass
                logging.getLogger(__name__).error(
                    "Gemini syllabus exception=%s status=%s message=%s response_body=%s",
                    type(exc).__name__, status_code, redact(str(exc)), redact(body),
                )
            except Exception:
                logging.getLogger(__name__).error("Gemini syllabus diagnostic details unavailable.")
            detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
            raise AIProviderError(self.name, f"Gemini syllabus generation failed ({detail}).", status_code) from exc
        text = getattr(response, "text", None)
        if not text:
            raise AIProviderError(self.name, "Gemini returned no structured syllabus.")
        usage = getattr(response, "usage_metadata", None)
        return ProviderResult(
            text=text,
            sources=[],
            usage={
                "total_input_tokens": usage.prompt_token_count,
                "total_output_tokens": usage.candidates_token_count,
                "total_tokens": usage.total_token_count,
            } if usage is not None else None,
        )

    def count_input_tokens(self, prompt: str) -> int | None:
        try:
            response = self._client().models.count_tokens(model=self.model, contents=prompt)
        except Exception as exc:
            status_code = getattr(exc, "code", None)
            detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
            raise AIProviderError(self.name, f"Gemini input token count failed ({detail}).", status_code) from exc
        return getattr(response, "total_tokens", None)

    def research_structured(self, prompt: str, schema: dict) -> ProviderResult:
        try:
            interaction = self._client().interactions.create(
                model=self.model,
                input=prompt,
                tools=[{"type": "google_search"}],
                response_format={"type": "text", "mime_type": "application/json", "schema": schema},
            )
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if not isinstance(status_code, int):
                code = getattr(exc, "code", None)
                status_code = code if isinstance(code, int) else None
            detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
            raise AIProviderError(self.name, f"Gemini course research failed ({detail}).", status_code) from exc
        text = getattr(interaction, "output_text", None)
        if not text:
            raise AIProviderError(self.name, "Gemini returned no course research.")
        usage = getattr(interaction, "usage", None)
        usage_data = usage.model_dump(exclude_none=True) if usage is not None else None
        search_queries = self._extract_search_queries(interaction)
        search_count = len(search_queries) if search_queries else self._extract_search_count(usage)
        return ProviderResult(
            text=text,
            sources=self._extract_grounded_sources(interaction),
            usage=usage_data,
            search_queries=search_queries,
            search_query_count=search_count,
        )

    def research_structured_direct(self, prompt: str, schema: dict) -> ProviderResult:
        try:
            interaction = self._client().interactions.create(
                model=self.model,
                input=prompt,
                response_format={"type": "text", "mime_type": "application/json", "schema": schema},
            )
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if not isinstance(status_code, int):
                code = getattr(exc, "code", None)
                status_code = code if isinstance(code, int) else None
            detail = f"HTTP {status_code}" if isinstance(status_code, int) else type(exc).__name__
            raise AIProviderError(self.name, f"Gemini direct research failed ({detail}).", status_code) from exc
        text = getattr(interaction, "output_text", None)
        if not text:
            raise AIProviderError(self.name, "Gemini returned no direct research.")
        usage = getattr(interaction, "usage", None)
        return ProviderResult(
            text=text,
            sources=self._extract_grounded_sources(interaction),
            usage=usage.model_dump(exclude_none=True) if usage is not None else None,
            search_queries=[],
            search_query_count=0,
        )

    def test_connection(self) -> None:
        try:
            response = self._client().models.generate_content(
                model=self.model,
                contents="Reply with exactly: ok",
            )
        except Exception as exc:
            raise AIProviderError(self.name, "Gemini connectivity test failed.") from exc
        if not getattr(response, "text", None):
            raise AIProviderError(self.name, "Gemini returned no test response.")

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