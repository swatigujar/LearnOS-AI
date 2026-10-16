from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from firebase_admin import firestore
from pydantic import ValidationError

from app.api.dependencies import get_current_user
from app.api.schemas.syllabus import GeneratedSyllabus
from app.api.schemas.tutor import TutorAction, TutorConversation, TutorStateResponse
from app.core.firebase import get_firestore_client
from app.services.ai_provider import AIProviderError
from app.services.notes import generate_topic_notes, note_document_id
from app.services.tutor import confirm_concept, ensure_topic_available, ordered_topics, teach

router = APIRouter(prefix="/api/tutor", tags=["tutor"])


def _context(course_id, user):
    if not user.get("uid"):
        raise HTTPException(401, "Please sign in to continue.")
    database = get_firestore_client()
    course_ref = database.document(f"users/{user['uid']}/courses/{course_id}")
    course = course_ref.get().to_dict()
    if not course:
        raise HTTPException(404, "Course not found for this user.")
    legacy_ref = None
    if course.get("sourceLearningGoalId") == course_id:
        legacy_ref = database.document(f"users/{user['uid']}/learningGoals/{course_id}")
        if not legacy_ref.get().exists:
            raise HTTPException(404, "This course was deleted.")
    version = course.get("syllabusVersion")
    if course.get("syllabusStatus") != "ready" or type(version) is not int or version < 1:
        raise HTTPException(409, "A saved, ready syllabus is required before tutoring.")
    saved = course_ref.collection("syllabus").document(f"v{version}").get()
    if not saved.exists:
        raise HTTPException(409, "The saved syllabus is missing.")
    syllabus = GeneratedSyllabus.model_validate({
        key: value for key, value in saved.to_dict().items() if key in GeneratedSyllabus.model_fields
    })
    profile = database.document(f"users/{user['uid']}").get().to_dict() or {}
    name = str(profile.get("displayName") or user.get("name") or "Learner")[:100]
    return database, course_ref, legacy_ref, course, syllabus, name


def _initial(course, syllabus):
    return {"syllabus_version": course["syllabusVersion"], "active_topic_id": ordered_topics(syllabus)[0][1].topic_id,
            "paused": False, "revision": 0, "topic_status": {}, "confirmed_modules": [],
            "operations": [], "pending": None}


def _busy(state):
    pending = state.get("pending")
    return bool(pending and pending["started_at"] > datetime.now(timezone.utc) - timedelta(minutes=3))


def _state(state_ref, course, syllabus, transaction=None):
    state = state_ref.get(transaction=transaction).to_dict() or _initial(course, syllabus)
    if state["syllabus_version"] != course["syllabusVersion"]:
        raise HTTPException(409, "The syllabus changed; tutor progress requires review.")
    return state


def _check_course(transaction, course_ref, legacy_ref, version):
    course = course_ref.get(transaction=transaction).to_dict() or {}
    if course.get("syllabusStatus") != "ready" or course.get("syllabusVersion") != version:
        raise HTTPException(409, "The course changed during this tutor request.")
    if legacy_ref is not None and not legacy_ref.get(transaction=transaction).exists:
        raise HTTPException(404, "This course was deleted.")


def _response(context):
    _, course_ref, _, course, syllabus, name = context
    state = _state(course_ref.collection("tutor").document("state"), course, syllabus)
    topic_ref = course_ref.collection("tutorTopics").document(state["active_topic_id"])
    conversation = TutorConversation.model_validate(topic_ref.get().to_dict() or {})
    statuses = {topic.topic_id: state["topic_status"].get(topic.topic_id, "not_started")
                for _, topic in ordered_topics(syllabus)}
    modules = {module.module_id: (
        "completed" if module.module_id in state["confirmed_modules"] else
        "in_progress" if any(statuses[topic.topic_id] != "not_started" for topic in module.topics) else "not_started"
    ) for module in syllabus.modules}
    return TutorStateResponse(
        learner_name=name, active_topic_id=state["active_topic_id"], syllabus_version=state["syllabus_version"],
        revision=state["revision"], paused=state["paused"], busy=_busy(state), topic_status=statuses,
        module_status=modules, conversation=conversation,
        can_confirm=bool(conversation.concepts and conversation.taught_index == conversation.concept_index
                         and not state["paused"] and not _busy(state)),
    )


@firestore.transactional
def _prepare(transaction, context, request):
    _, course_ref, legacy_ref, course, syllabus, _ = context
    state_ref = course_ref.collection("tutor").document("state")
    topic_ref = course_ref.collection("tutorTopics").document(request.topicId)
    _check_course(transaction, course_ref, legacy_ref, course["syllabusVersion"])
    state = _state(state_ref, course, syllabus, transaction)
    conversation = TutorConversation.model_validate(topic_ref.get(transaction=transaction).to_dict() or {}).model_dump()
    queue_notes = False
    if request.operationId in state["operations"]:
        return None
    if _busy(state):
        raise HTTPException(409, "A tutor request is already running. Wait before sending another.")
    if request.revision != state["revision"]:
        raise HTTPException(409, "Tutor state changed. Refresh the conversation before retrying.")
    try:
        module, topic = ensure_topic_available(syllabus, state, request.topicId)
        if request.action not in ("select", "pause", "resume") and request.topicId != state["active_topic_id"]:
            raise ValueError("Select this topic before interacting with it.")
        if state["paused"] and request.action not in ("resume", "select", "pause"):
            raise ValueError("Resume the lesson before continuing.")
        needs_model = request.action in ("start", "message", "explain", "repeat")
        if request.action == "select":
            state["active_topic_id"] = request.topicId
            needs_model = not state["paused"] and conversation["taught_index"] != conversation["concept_index"]
        elif request.action == "pause":
            state["paused"] = True
        elif request.action == "resume":
            state["paused"] = False
        elif request.action == "confirm_module":
            if not all(state["topic_status"].get(item.topic_id) == "completed" for item in module.topics):
                raise ValueError("Confirm every topic before completing this module.")
            if module.module_id not in state["confirmed_modules"]:
                state["confirmed_modules"].append(module.module_id)
        elif request.action == "confirm":
            already_completed = state["topic_status"].get(request.topicId) == "completed"
            if confirm_concept(conversation, request.conceptIndex):
                state["topic_status"][request.topicId] = "completed"
                conversation["taught_index"] = None
                if not already_completed:
                    note_ref = course_ref.collection("notes").document(
                        note_document_id(request.topicId, course["syllabusVersion"])
                    )
                    if not note_ref.get(transaction=transaction).exists:
                        transaction.create(note_ref, {
                            "courseId": request.courseId,
                            "topicId": request.topicId,
                            "syllabusVersion": course["syllabusVersion"],
                            "title": topic.title,
                            "status": "queued",
                            "attempts": 0,
                            "createdAt": firestore.SERVER_TIMESTAMP,
                            "updatedAt": firestore.SERVER_TIMESTAMP,
                        })
                        queue_notes = True
            else:
                needs_model = True
        elif request.action == "repeat":
            conversation["concept_index"] = 0
            conversation["taught_index"] = None
        elif request.action == "start" and conversation["taught_index"] == conversation["concept_index"]:
            needs_model = False
        if needs_model:
            if request.action == "message":
                conversation["messages"] = [*conversation["messages"],
                    {"role": "user", "text": request.message.strip(), "reply": None}][-20:]
            if state["topic_status"].get(request.topicId) != "completed":
                state["topic_status"][request.topicId] = "in_progress"
            state["pending"] = {"id": request.operationId, "started_at": datetime.now(timezone.utc)}
        else:
            state["pending"] = None
            state["operations"] = [*state["operations"], request.operationId][-100:]
        state["revision"] += 1
        transaction.set(state_ref, state)
        transaction.set(topic_ref, conversation)
        return {
            "tutor": (module, topic, conversation) if needs_model else None,
            "queue_notes": queue_notes,
        }
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@firestore.transactional
def _finish(transaction, context, request, reply):
    _, course_ref, legacy_ref, course, syllabus, _ = context
    state_ref = course_ref.collection("tutor").document("state")
    topic_ref = course_ref.collection("tutorTopics").document(request.topicId)
    _check_course(transaction, course_ref, legacy_ref, course["syllabusVersion"])
    state = _state(state_ref, course, syllabus, transaction)
    conversation = TutorConversation.model_validate(topic_ref.get(transaction=transaction).to_dict() or {}).model_dump()
    if (state.get("pending") or {}).get("id") != request.operationId:
        raise HTTPException(409, "This tutor request is no longer active.")
    if reply is not None:
        conversation["concepts"] = reply.concepts
        conversation["taught_index"] = conversation["concept_index"]
        if request.action == "explain":
            conversation["messages"].append({"role": "user", "text": "Please explain again differently.", "reply": None})
        conversation["messages"].append({"role": "assistant", "text": "", "reply": reply.model_dump()})
        conversation["messages"] = conversation["messages"][-20:]
        transaction.set(topic_ref, TutorConversation.model_validate(conversation).model_dump())
    state["pending"] = None
    state["operations"] = [*state["operations"], request.operationId][-100:]
    state["revision"] += 1
    transaction.set(state_ref, state)


@router.get("/state", response_model=TutorStateResponse)
def get_tutor_state(courseId: str = Query(min_length=1, max_length=150, pattern=r"^[^/]+$"),
                    user: dict = Depends(get_current_user)):
    try:
        return _response(_context(courseId, user))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Tutor state could not be loaded. Your saved progress is unchanged.") from exc


@router.post("/action", response_model=TutorStateResponse)
def tutor_action(request: TutorAction, background_tasks: BackgroundTasks,
                 user: dict = Depends(get_current_user)):
    try:
        context = _context(request.courseId, user)
        prepared = _prepare(context[0].transaction(), context, request)
        if prepared and prepared["queue_notes"]:
            background_tasks.add_task(generate_topic_notes, user["uid"], request.courseId, request.topicId,
                                      context[3]["syllabusVersion"])
        if prepared and prepared["tutor"]:
            module, topic, conversation = prepared["tutor"]
            try:
                reply = teach(context[4], module, topic, context[3], context[5], conversation,
                              request.action, request.message, request_id=request.operationId)
            except Exception as exc:
                _finish(context[0].transaction(), context, request, None)
                if isinstance(exc, AIProviderError):
                    status = exc.status_code if exc.status_code in (429, 503, 504) else 502
                    if "deadline" in str(exc):
                        status = 504
                    detail = f"Gemini tutor request failed (HTTP {exc.status_code or status}). Your progress is saved."
                elif isinstance(exc, ValidationError):
                    issues = "; ".join(
                        f"{'.'.join(str(part) for part in issue['loc']) or 'response'}: {issue['type']}"
                        for issue in exc.errors(include_input=False, include_context=False)[:3]
                    )
                    status, detail = 502, f"Tutor reply failed validation ({issues}). Your progress is saved."
                else:
                    reason = str(exc) if isinstance(exc, ValueError) and str(exc) in (
                        "Tutor changed the active concept plan.", "Tutor returned an unverified resource URL."
                    ) else "Invalid JSON or lesson response."
                    status, detail = 502, f"Tutor reply rejected: {reason} Your progress is saved."
                raise HTTPException(status, detail) from exc
            _finish(context[0].transaction(), context, request, reply)
        return _response(context)
    except HTTPException:
        raise
    except (ValidationError, ValueError) as exc:
        raise HTTPException(409, "Saved tutor data needs review; no completion was recorded.") from exc
    except Exception as exc:
        raise HTTPException(503, "Tutor state could not be saved. Reload before retrying; no automatic retry was made.") from exc
