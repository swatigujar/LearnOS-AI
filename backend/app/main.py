from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse
from app.api.routes.ai import router as ai_router
from app.api.routes.syllabus import router as syllabus_router
from app.api.routes.tutor import router as tutor_router
from app.api.routes.mock_test import router as mock_test_router
from app.api.routes.notes import router as notes_router

app = FastAPI(title="LearnOS AI API")
app.include_router(syllabus_router)
app.include_router(ai_router)
app.include_router(tutor_router)
app.include_router(mock_test_router)
app.include_router(notes_router)


@app.exception_handler(HTTPException)
async def handle_http_exception(request: Request, exc: HTTPException):
    if exc.status_code == 401:
        return JSONResponse(
            status_code=401,
            headers=exc.headers,
            content={
                "status": "failed",
                "code": "AUTHENTICATION_REQUIRED",
                "message": "Please sign in to continue.",
            },
        )
    if exc.status_code == 503 and exc.detail == "Firebase token verification is unavailable.":
        return JSONResponse(
            status_code=503,
            headers=exc.headers,
            content={
                "status": "failed",
                "code": "AUTHENTICATION_UNAVAILABLE",
                "message": "Authentication could not be verified. Please try again.",
            },
        )
    return await http_exception_handler(request, exc)


@app.get("/health")
def health_check():
    return {"status": "healthy"}
