from fastapi import APIRouter, Depends, HTTPException

from app.api.dependencies import get_current_user
from app.core.config import AI_TEST_ENDPOINT_ENABLED
from app.services.ai_provider import AIProviderError, get_ai_provider

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/test")
def test_ai_provider(user: dict = Depends(get_current_user)) -> dict[str, str]:
    if not AI_TEST_ENDPOINT_ENABLED:
        raise HTTPException(status_code=404, detail="Not found.")
    if not user.get("uid"):
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")
    try:
        provider = get_ai_provider()
        provider.test_connection()
    except AIProviderError as exc:
        status = exc.status_code if exc.status_code in (429, 503, 504) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"provider": provider.name, "model": provider.model, "status": "ok"}
