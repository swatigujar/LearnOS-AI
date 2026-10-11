from fastapi import APIRouter, HTTPException

from app.services.ai_provider import AIProviderError, get_ai_provider

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/test")
def test_ai_provider() -> dict[str, str]:
    try:
        provider = get_ai_provider()
        provider.test_connection()
    except AIProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"provider": provider.name, "model": provider.model, "status": "ok"}