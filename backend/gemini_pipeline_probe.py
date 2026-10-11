import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types


BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe Gemini research, summary, and syllabus stages.")
    parser.add_argument(
        "--quick-check",
        action="store_true",
        help="Send one tiny plain Gemini request and stop.",
    )
    parser.add_argument("--course", default="E2E direct Gemini pipeline test")
    parser.add_argument(
        "--goal",
        default="Learn Python fundamentals for practical scripting and small automation tasks.",
    )
    parser.add_argument("--level", default="beginner")
    parser.add_argument("--timeline-days", type=int, default=30)
    parser.add_argument("--study-hours-per-day", type=float, default=1)
    parser.add_argument("--learning-style", default="No preference")
    parser.add_argument(
        "--requirements",
        default="Prefer official Python documentation and free resources.",
    )
    return parser.parse_args()


def usage_value(metadata, field: str):
    value = getattr(metadata, field, None) if metadata is not None else None
    return value if value is not None else "unavailable"


def run_quick_check(client, model: str) -> bool:
    print("===== QUICK CONNECTIVITY CHECK =====", flush=True)
    try:
        response = client.models.generate_content(
            model=model,
            contents="Reply with exactly: OK.",
        )
    except Exception as error:
        status_code = getattr(error, "code", None)
        if not isinstance(status_code, int):
            status_code = getattr(error, "status_code", None)
        message = getattr(error, "message", None) or str(error)
        api_key = os.getenv("GEMINI_API_KEY", "")
        if api_key:
            message = message.replace(api_key, "[redacted]")
        print(f"STATUS: FAILED\nHTTP STATUS: {status_code or 'unavailable'}")
        print(f"MODEL: {model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
        print(f"ERROR: {message}")
        return False

    metadata = getattr(response, "usage_metadata", None)
    print("STATUS: SUCCESS\nHTTP STATUS: 200")
    print(f"MODEL: {model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
    print(f"INPUT TOKENS: {usage_value(metadata, 'prompt_token_count')}")
    print(f"OUTPUT TOKENS: {usage_value(metadata, 'candidates_token_count')}")
    print(f"TOTAL TOKENS: {usage_value(metadata, 'total_token_count')}")
    print(f"RESPONSE: {response.text or 'unavailable'}")
    return True


def run_stage(client, model: str, name: str, system_instruction: str, prompt: str):
    print(f"\n===== {name} =====", flush=True)
    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
            ),
        )
    except Exception as error:
        status_code = getattr(error, "code", None)
        if not isinstance(status_code, int):
            status_code = getattr(error, "status_code", None)
        message = getattr(error, "message", None) or str(error)
        api_key = os.getenv("GEMINI_API_KEY", "")
        if api_key:
            message = message.replace(api_key, "[redacted]")
        print(f"STATUS: FAILED\nHTTP STATUS: {status_code or 'unavailable'}")
        print(f"MODEL: {model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
        print(f"ERROR: {message}")
        return None

    metadata = getattr(response, "usage_metadata", None)
    print("STATUS: SUCCESS\nHTTP STATUS: 200")
    print(f"MODEL: {model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
    print(f"INPUT TOKENS: {usage_value(metadata, 'prompt_token_count')}")
    print(f"OUTPUT TOKENS: {usage_value(metadata, 'candidates_token_count')}")
    print(f"TOTAL TOKENS: {usage_value(metadata, 'total_token_count')}")
    print("RESPONSE:")
    print(response.text or "unavailable")
    return response.text


def main() -> int:
    args = parse_args()
    api_key = os.getenv("GEMINI_API_KEY")
    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
    if not api_key:
        print("STATUS: FAILED\nERROR: GEMINI_API_KEY is not configured in backend/.env")
        return 2

    learner = {
        "course": args.course,
        "desired_outcome": args.goal,
        "skill_level": args.level,
        "timeline_days": args.timeline_days,
        "study_hours_per_day": args.study_hours_per_day,
        "learning_style": args.learning_style,
        "additional_requirements": args.requirements,
    }
    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(
            timeout=50_000,
            retry_options=types.HttpRetryOptions(attempts=0),
        ),
    )

    if args.quick_check:
        return 0 if run_quick_check(client, model) else 1

    research = run_stage(
        client,
        model,
        "DIRECT RESEARCH (no Google Search)",
        "Analyze the learner's supplied goal using your model knowledge. Do not browse or use tools. "
        "Return JSON with important_topics, key_concepts, prerequisites, recommended_learning_order, "
        "important_subtopics, outcome_topics, and reliable resource suggestions. Do not invent URLs; "
        "leave resource suggestions empty if you cannot provide them reliably.",
        f"Learner details:\n{learner}",
    )
    if research is None:
        return 1

    summary = run_stage(
        client,
        model,
        "SUMMARIZATION",
        "Summarize the supplied research into a concise learning map for this learner. Preserve their "
        "goal, level, time constraints, prerequisites, ordering, and reliable resources. Do not generate "
        "a syllabus in this stage. Return JSON.",
        f"Learner details:\n{learner}\n\nResearch output:\n{research}",
    )
    if summary is None:
        return 1

    syllabus = run_stage(
        client,
        model,
        "SYLLABUS GENERATION",
        "Generate a practical, ordered learning syllabus for the supplied learner. Use modules and topics, "
        "prerequisites, objectives, estimated study hours, and reliable resources. Fit all study estimates "
        "within timeline_days multiplied by study_hours_per_day. Do not invent URLs. Return JSON.",
        f"Learner details:\n{learner}\n\nResearch:\n{research}\n\nSummary:\n{summary}",
    )
    return 0 if syllabus is not None else 1


if __name__ == "__main__":
    sys.exit(main())