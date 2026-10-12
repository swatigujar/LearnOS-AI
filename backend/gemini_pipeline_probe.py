import argparse
import sys
from uuid import uuid4

from app.core.config import GEMINI_API_KEY
from app.services.ai_provider import GeminiProvider


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


def run_quick_check(provider: GeminiProvider) -> bool:
    print("===== QUICK CONNECTIVITY CHECK =====", flush=True)
    try:
        result = provider.test_connection()
    except Exception as error:
        status_code = getattr(error, "status_code", None)
        print(f"STATUS: FAILED\nHTTP STATUS: {status_code or 'unavailable'}")
        print(f"MODEL: {provider.model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
        print("ERROR: Gemini connectivity check failed.")
        return False

    print("STATUS: SUCCESS\nHTTP STATUS: 200")
    print(f"MODEL: {provider.model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
    print(f"INPUT TOKENS: {result.usage.get('total_input_tokens') if result.usage else 'unavailable'}")
    print(f"OUTPUT TOKENS: {result.usage.get('total_output_tokens') if result.usage else 'unavailable'}")
    print(f"THINKING TOKENS: {result.usage.get('total_thought_tokens') if result.usage else 'unavailable'}")
    return True


def run_stage(provider: GeminiProvider, name: str, system_instruction: str, prompt: str):
    print(f"\n===== {name} =====", flush=True)
    try:
        result = provider.generate_structured(
            f"{system_instruction}\n{prompt}",
            {"type": "object"},
            feature="developer_probe",
            request_id=f"{uuid4().hex}:{name.lower().replace(' ', '_')}",
        )
    except Exception as error:
        status_code = getattr(error, "status_code", None)
        print(f"STATUS: FAILED\nHTTP STATUS: {status_code or 'unavailable'}")
        print(f"MODEL: {provider.model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
        print("ERROR: Gemini pipeline stage failed.")
        return None

    print("STATUS: SUCCESS\nHTTP STATUS: 200")
    print(f"MODEL: {provider.model}\nRETRY ATTEMPTS: 1 (one request, zero retries)")
    print(f"INPUT TOKENS: {result.usage.get('total_input_tokens') if result.usage else 'unavailable'}")
    print(f"OUTPUT TOKENS: {result.usage.get('total_output_tokens') if result.usage else 'unavailable'}")
    print(f"THINKING TOKENS: {result.usage.get('total_thought_tokens') if result.usage else 'unavailable'}")
    return result.text


def main() -> int:
    args = parse_args()
    if not GEMINI_API_KEY:
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
    provider = GeminiProvider()

    if args.quick_check:
        return 0 if run_quick_check(provider) else 1

    research = run_stage(
        provider,
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
        provider,
        "SUMMARIZATION",
        "Summarize the supplied research into a concise learning map for this learner. Preserve their "
        "goal, level, time constraints, prerequisites, ordering, and reliable resources. Do not generate "
        "a syllabus in this stage. Return JSON.",
        f"Learner details:\n{learner}\n\nResearch output:\n{research}",
    )
    if summary is None:
        return 1

    syllabus = run_stage(
        provider,
        "SYLLABUS GENERATION",
        "Generate a practical, ordered learning syllabus for the supplied learner. Use modules and topics, "
        "prerequisites, objectives, estimated study hours, and reliable resources. Fit all study estimates "
        "within timeline_days multiplied by study_hours_per_day. Do not invent URLs. Return JSON.",
        f"Learner details:\n{learner}\n\nResearch:\n{research}\n\nSummary:\n{summary}",
    )
    return 0 if syllabus is not None else 1


if __name__ == "__main__":
    sys.exit(main())
