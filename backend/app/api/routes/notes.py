import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path
from fastapi.responses import Response

from app.api.dependencies import get_current_user
from app.api.schemas.notes import NotesDeleteResponse, NotesRetryResponse
from app.services.notes import delete_course_notes, generate_topic_notes, read_note_image, retry_topic_notes

router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.delete("/{courseId}", response_model=NotesDeleteResponse)
def remove_course_notes(courseId: str = Path(min_length=1, max_length=150, pattern=r"^[^/]+$"),
                        user: dict = Depends(get_current_user)):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(401, "Please sign in to continue.")
    deleted = delete_course_notes(uid, courseId)
    return NotesDeleteResponse(courseId=courseId, deletedNotes=deleted)


@router.post("/{courseId}/{topicId}/retry", response_model=NotesRetryResponse)
def retry_notes(courseId: str, topicId: str, background_tasks: BackgroundTasks,
                user: dict = Depends(get_current_user)):
    if not re.fullmatch(r"module-\d+-topic-\d+", topicId):
        raise HTTPException(404, "Subtopic not found.")
    uid = user.get("uid")
    if not uid:
        raise HTTPException(401, "Please sign in to continue.")
    version, status, should_queue = retry_topic_notes(uid, courseId, topicId)
    if should_queue:
        background_tasks.add_task(generate_topic_notes, uid, courseId, topicId, version)
    return NotesRetryResponse(courseId=courseId, topicId=topicId, status=status)


@router.get("/{courseId}/{topicId}/image")
def get_note_image(courseId: str, topicId: str, user: dict = Depends(get_current_user)):
    if not re.fullmatch(r"module-\d+-topic-\d+", topicId):
        raise HTTPException(404, "Notes image not found.")
    uid = user.get("uid")
    if not uid:
        raise HTTPException(401, "Please sign in to continue.")
    data = read_note_image(uid, courseId, topicId)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})
