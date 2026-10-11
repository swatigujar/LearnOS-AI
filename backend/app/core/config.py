import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_ROOT / ".env")
_backend_env = dotenv_values(BACKEND_ROOT / ".env")

GEMINI_API_KEY = _backend_env.get("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", os.getenv("AI_MODEL", "gemini-3.8-flash"))
FIREBASE_PROJECT_ID = (
	os.getenv("FIREBASE_PROJECT_ID")
	or os.getenv("GOOGLE_CLOUD_PROJECT")
	or os.getenv("GCLOUD_PROJECT")
)