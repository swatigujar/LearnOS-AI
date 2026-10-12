import os
from pathlib import Path
from datetime import date, datetime, timezone

from dotenv import dotenv_values, load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_ROOT / ".env")
_backend_env = dotenv_values(BACKEND_ROOT / ".env")

GEMINI_API_KEY = _backend_env.get("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", os.getenv("AI_MODEL", "gemini-3.8-flash"))
AI_DAILY_REQUEST_LIMIT = int(os.getenv("AI_DAILY_REQUEST_LIMIT", "200"))
AI_MONTHLY_ESTIMATED_COST_LIMIT_USD = float(os.getenv("AI_MONTHLY_ESTIMATED_COST_LIMIT_USD", "25"))
AI_MAX_OUTPUT_TOKENS = int(os.getenv("AI_MAX_OUTPUT_TOKENS", "8192"))
AI_TEST_ENDPOINT_ENABLED = os.getenv("AI_TEST_ENDPOINT_ENABLED", "false").lower() == "true"
GEMINI_SEARCH_PRICE_PER_THOUSAND_USD = float(os.getenv("GEMINI_SEARCH_PRICE_PER_THOUSAND_USD", "14"))

# Defaults match the existing Gemini 3.8 Flash research pricing. Set both values
# explicitly when using another model or when the provider changes pricing.
_gemini_38_intro_pricing_active = (
    GEMINI_MODEL == "gemini-3.8-flash"
    and datetime.now(timezone.utc).date() <= date(2026, 12, 31)
)
GEMINI_INPUT_PRICE_PER_MILLION_USD = os.getenv(
    "GEMINI_INPUT_PRICE_PER_MILLION_USD",
    "0.75" if _gemini_38_intro_pricing_active else None,
)
GEMINI_OUTPUT_PRICE_PER_MILLION_USD = os.getenv(
    "GEMINI_OUTPUT_PRICE_PER_MILLION_USD",
    "3.75" if _gemini_38_intro_pricing_active else None,
)
FIREBASE_PROJECT_ID = (
	os.getenv("FIREBASE_PROJECT_ID")
	or os.getenv("GOOGLE_CLOUD_PROJECT")
	or os.getenv("GCLOUD_PROJECT")
)
