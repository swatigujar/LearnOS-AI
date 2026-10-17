import os
from pathlib import Path
from datetime import date, datetime, timezone

from dotenv import dotenv_values, load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_ROOT / ".env")
_backend_env = dotenv_values(BACKEND_ROOT / ".env")

GEMINI_API_KEY = _backend_env.get("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", os.getenv("AI_MODEL", "gemini-3.8-flash"))
GEMINI_LIVE_ENABLED = os.getenv("GEMINI_LIVE_ENABLED", "true").lower() == "true"
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.8-live")
GEMINI_LIVE_SESSION_COST_RESERVE_USD = float(os.getenv("GEMINI_LIVE_SESSION_COST_RESERVE_USD", "2.00"))
# Live API standard-tier token prices per million; override when Google's rates change.
GEMINI_LIVE_INPUT_TEXT_PRICE_PER_MILLION_USD = float(os.getenv("GEMINI_LIVE_INPUT_TEXT_PRICE_PER_MILLION_USD", "0.75"))
GEMINI_LIVE_INPUT_AUDIO_PRICE_PER_MILLION_USD = float(os.getenv("GEMINI_LIVE_INPUT_AUDIO_PRICE_PER_MILLION_USD", "3.00"))
GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD = float(os.getenv("GEMINI_LIVE_INPUT_IMAGE_VIDEO_PRICE_PER_MILLION_USD", "1.00"))
GEMINI_LIVE_OUTPUT_TEXT_PRICE_PER_MILLION_USD = float(os.getenv("GEMINI_LIVE_OUTPUT_TEXT_PRICE_PER_MILLION_USD", "4.50"))
GEMINI_LIVE_OUTPUT_AUDIO_PRICE_PER_MILLION_USD = float(os.getenv("GEMINI_LIVE_OUTPUT_AUDIO_PRICE_PER_MILLION_USD", "12.00"))
# Display-only exchange rate for estimated rupee costs; override with a current rate.
USD_TO_INR_RATE = os.getenv("USD_TO_INR_RATE", "90.0")
AI_DAILY_REQUEST_LIMIT = int(os.getenv("AI_DAILY_REQUEST_LIMIT", "200"))
AI_MONTHLY_ESTIMATED_COST_LIMIT_USD = float(os.getenv("AI_MONTHLY_ESTIMATED_COST_LIMIT_USD", "25"))
AI_MAX_OUTPUT_TOKENS = int(os.getenv("AI_MAX_OUTPUT_TOKENS", "8192"))
AI_TEST_ENDPOINT_ENABLED = os.getenv("AI_TEST_ENDPOINT_ENABLED", "false").lower() == "true"
GEMINI_SEARCH_PRICE_PER_THOUSAND_USD = float(os.getenv("GEMINI_SEARCH_PRICE_PER_THOUSAND_USD", "14"))
GEMINI_NOTES_IMAGE_MODEL = os.getenv("GEMINI_NOTES_IMAGE_MODEL", "gemini-3.1-flash-image")
GEMINI_NOTES_IMAGE_SIZE = os.getenv("GEMINI_NOTES_IMAGE_SIZE", "2K")
# Reserve above the published 2K image price to keep the shared monthly cap conservative.
GEMINI_NOTES_IMAGE_COST_USD = float(os.getenv("GEMINI_NOTES_IMAGE_COST_USD", "0.18"))
FIREBASE_STORAGE_BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET")

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
