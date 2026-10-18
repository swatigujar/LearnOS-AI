import re
from datetime import datetime, timedelta, timezone
from logging import getLogger

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from firebase_admin import firestore
from pydantic import ValidationError

from app.api.dependencies import get_current_user
from app.api.schemas.notes import GeneratedNotes
from app.api.schemas.syllabus import GeneratedSyllabus
from app.api.schemas.tutor import (
    TutorAction,
    TutorCancelRequest,
    TutorConversation,
    TutorHistoryResponse,
    TutorLiveSessionRequest,
    TutorLiveTranscriptRequest,
    TutorMessage,
    TutorStateResponse,
)
from app.core.config import GEMINI_LIVE_ENABLED, GEMINI_LIVE_MODEL, GEMINI_LIVE_SESSION_COST_RESERVE_USD
from app.core.firebase import get_firestore_client
from app.services.ai_provider import AIProviderError
from app.services.ai_usage import UsageLimitError, log_live_usage
from app.services.live_tutor import build_live_instruction, create_live_access_token, live_client_config
from app.services.notes import generate_topic_notes, note_document_id
from app.services.tutor import confirm_concept, current_concept_taught, ensure_topic_available, ordered_topics, teach

router = APIRouter(prefix="/api/tutor", tags=["tutor"])
logger = getLogger(__name__)


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
            "operations": [], "pending": None, "progress_epoch": 0}


def _busy(state):
    pending = state.get("pending")
    return bool(pending and pending["started_at"] > datetime.now(timezone.utc) - timedelta(minutes=3))


def _state(state_ref, course, syllabus, transaction=None):
    state = state_ref.get(transaction=transaction).to_dict() or _initial(course, syllabus)
    if state["syllabus_version"] != course["syllabusVersion"]:
        raise HTTPException(409, "The syllabus changed; tutor progress requires review.")
    return state


def _conversation(topic_ref, state, transaction=None):
    saved = topic_ref.get(transaction=transaction).to_dict() or {}
    if saved.get("progress_epoch", 0) != state.get("progress_epoch", 0):
        return TutorConversation().model_dump()
    saved.pop("progress_epoch", None)
    return TutorConversation.model_validate(saved).model_dump()


def _conversation_document(conversation, state):
    return {**conversation, "progress_epoch": state.get("progress_epoch", 0)}


def _requested_topic_id(syllabus, message, active_topic_id):
    normalized = re.sub(r"[^\w]+", " ", message.casefold(), flags=re.UNICODE).strip()
    if not re.search(
        r"\b(?:learn|teach|switch|go|move|study|start|begin|cover|next|change|want|like|can|let|estudiar|aprender|apprendre|étudier|lernen)\b"
        r"|सीख|पढ़|शुरू|बदल|शिक|अभ्यास|चलो",
        normalized,
    ):
        return None
    topics = [topic for _, topic in ordered_topics(syllabus)]
    active_index = next((index for index, topic in enumerate(topics) if topic.topic_id == active_topic_id), -1)
    if re.search(r"\b(?:next|following|another)\s+(?:topic|lesson)\b", normalized):
        return topics[active_index + 1].topic_id if 0 <= active_index < len(topics) - 1 else None

    stop_words = {"a", "an", "and", "at", "for", "from", "in", "intro", "introduction", "of", "on", "the", "to", "with"}
    message_terms = set(normalized.split()) - stop_words
    title_terms = {}
    normalized_titles = {}
    for topic in topics:
        if topic.topic_id == active_topic_id:
            continue
        title = re.sub(r"[^\w]+", " ", topic.title.casefold(), flags=re.UNICODE).strip()
        terms = set(title.split()) - stop_words
        if not terms:
            continue
        normalized_titles[topic.topic_id] = title
        title_terms[topic.topic_id] = terms

    exact_matches = [topic for topic in topics
                     if topic.topic_id in normalized_titles and normalized_titles[topic.topic_id] in normalized]
    if exact_matches:
        return max(exact_matches, key=lambda topic: len(normalized_titles[topic.topic_id])).topic_id

    term_frequency = {}
    for terms in title_terms.values():
        for term in terms:
            term_frequency[term] = term_frequency.get(term, 0) + 1
    scored = []
    for topic in topics:
        terms = title_terms.get(topic.topic_id, set())
        hits = terms & message_terms
        unique_hits = {term for term in hits if term_frequency[term] == 1}
        if unique_hits:
            scored.append((2, len(unique_hits), len(hits), topic))
        elif len(hits) >= 2 and len(hits) / len(terms) >= 0.5:
            scored.append((1, len(hits), len(hits) / len(terms), topic))
    if not scored:
        return None
    scored.sort(key=lambda item: item[:3], reverse=True)
    if len(scored) > 1 and scored[0][:3] == scored[1][:3]:
        return None
    return scored[0][3].topic_id


def _recent_learning_history(course_ref, progress_epoch=0, limit=12):
    try:
        snapshots = course_ref.collection("tutorHistory").order_by(
            "createdAt", direction=firestore.Query.DESCENDING
        ).limit(limit).stream()
        snapshots = list(snapshots)
    except Exception:
        return []
    history = []
    for snapshot in reversed(snapshots):
        item = snapshot.to_dict() or {}
        if item.get("progressEpoch", 0) != progress_epoch:
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            history.append({
                "topic_id": item.get("topicId", ""),
                "role": item.get("role", ""),
                "channel": item.get("channel", "chat"),
                "text": text[:2000],
            })
    return history


def _course_progress_summary(context):
    _, course_ref, _, course, syllabus, _ = context
    state = _state(course_ref.collection("tutor").document("state"), course, syllabus)
    return [
        {
            "module": module.title,
            "topic": topic.title,
            "status": state.get("topic_status", {}).get(topic.topic_id, "not_started"),
        }
        for module in syllabus.modules for topic in module.topics
    ]


def _reply_history_text(reply):
    if reply.intent == "redirect":
        return reply.redirect_message[:4000]
    return "\n".join((
        reply.concept_title,
        reply.explanation,
        f"Example: {reply.example}",
        f"Question asked: {reply.check_question}",
    ))[:4000]


def _friendly_ai_error(status):
    if status == 429:
        return "The tutor has reached its AI request limit for now. Your progress is saved. Please try again later."
    if status == 503:
        return "The tutor is temporarily unavailable. Your progress is saved. Please try again shortly."
    if status == 504:
        return "The tutor took longer than expected to respond. Your progress is saved. Please try again."
    return "I couldn't prepare a reliable tutor response just now. Your progress is saved. Please try again."


def _live_course_context(context, topic_id):
    _, course_ref, _, course, syllabus, learner_name = context
    state = _state(course_ref.collection("tutor").document("state"), course, syllabus)
    if state["active_topic_id"] != topic_id:
        raise HTTPException(409, "Select this lesson before starting the live tutor.")
    if state["paused"] or _busy(state):
        raise HTTPException(409, "Resume the lesson and wait for tutor actions to finish before starting live voice.")
    module, topic = ensure_topic_available(syllabus, state, topic_id)
    topic_ref = course_ref.collection("tutorTopics").document(topic_id)
    conversation = TutorConversation.model_validate(_conversation(topic_ref, state))
    topic_status = state.get("topic_status", {})
    progress = [
        {
            "module": item.title,
            "topic": lesson.title,
            "status": topic_status.get(lesson.topic_id, "not_started"),
        }
        for item in syllabus.modules for lesson in item.topics
    ]
    learning_history = _recent_learning_history(course_ref, state.get("progress_epoch", 0))
    if not learning_history:
        topic_index = next(index for index, (_, item) in enumerate(ordered_topics(syllabus))
                           if item.topic_id == topic_id)
        previous_topics = [item for _, item in ordered_topics(syllabus)[:topic_index]
                           if topic_status.get(item.topic_id) in ("in_progress", "completed")][-3:]
        for previous in previous_topics:
            previous_data = course_ref.collection("tutorTopics").document(previous.topic_id).get().to_dict() or {}
            previous_conversation = TutorConversation.model_validate(previous_data)
            for message in previous_conversation.messages[-4:]:
                if message.reply is not None:
                    message_text = _reply_history_text(message.reply)
                else:
                    message_text = message.text
                if message_text.strip():
                    learning_history.append({
                        "topic_id": previous.topic_id,
                        "role": message.role,
                        "channel": message.channel,
                        "text": message_text[:2000],
                    })

    saved_notes = {}
    note_data = course_ref.collection("notes").document(
        note_document_id(topic_id, course["syllabusVersion"])
    ).get().to_dict() or {}
    if isinstance(note_data.get("structuredNotes"), dict):
        try:
            saved_notes = GeneratedNotes.model_validate(note_data["structuredNotes"]).model_dump(mode="json")
        except ValidationError:
            saved_notes = {}

    tutor_context = {
        "learner": {
            "name": learner_name,
            "goal": course.get("learning_goal", course.get("goalText", "")),
            "level": course.get("skill_level", course.get("skillLevel", "")),
            "preferences": course.get("learning_style", course.get("preferredLearningStyle", [])),
        },
        "course": {
            "name": course.get("course_name", course.get("courseName", "Saved course")),
            "overview": syllabus.overview,
            "objective": syllabus.objective,
            "prerequisites": syllabus.prerequisites,
        },
        "current_lesson": {
            "module": {"title": module.title, "description": module.description},
            "topic": topic.model_dump(mode="json"),
            "saved_course_notes": saved_notes,
        },
        "course_progress": progress,
        "official_course_resources": [
            {"title": item.title, "url": str(item.url), "description": item.description,
             "source_type": item.source_type}
            for item in syllabus.resources
        ],
        "current_lesson_conversation": [
            {
                "role": message.role,
                "text": (_reply_history_text(message.reply) if message.reply else message.text)[:2000],
            }
            for message in conversation.messages[-10:]
        ],
        "concept_plan": {
            "concepts": conversation.concepts,
            "current_index": conversation.concept_index,
        },
        "recent_course_learning_history": learning_history[-12:],
    }
    return tutor_context


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
    conversation = TutorConversation.model_validate(_conversation(topic_ref, state))
    statuses = {topic.topic_id: state["topic_status"].get(topic.topic_id, "not_started")
                for _, topic in ordered_topics(syllabus)}
    modules = {module.module_id: (
        "completed" if module.module_id in state["confirmed_modules"] else
        "in_progress" if any(statuses[topic.topic_id] != "not_started" for topic in module.topics) else "not_started"
    ) for module in syllabus.modules}
    return TutorStateResponse(
        learner_name=name, active_topic_id=state["active_topic_id"], syllabus_version=state["syllabus_version"],
        progress_epoch=state.get("progress_epoch", 0),
        revision=state["revision"], paused=state["paused"], busy=_busy(state), topic_status=statuses,
        pending_operation_id=state["pending"]["id"] if _busy(state) else None,
        module_status=modules, conversation=conversation,
        can_confirm=bool(conversation.concepts and conversation.taught_index == conversation.concept_index
                         and conversation.answered_index == conversation.concept_index
                         and not state["paused"] and not _busy(state)),
    )


@firestore.transactional
def _prepare(transaction, context, request):
    _, course_ref, legacy_ref, course, syllabus, _ = context
    state_ref = course_ref.collection("tutor").document("state")
    topic_ref = course_ref.collection("tutorTopics").document(request.topicId)
    _check_course(transaction, course_ref, legacy_ref, course["syllabusVersion"])
    state = _state(state_ref, course, syllabus, transaction)
    conversation = _conversation(topic_ref, state, transaction)
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
        if state["paused"] and request.action not in ("resume", "select", "pause", "restart"):
            raise ValueError("Resume the lesson before continuing.")
        if request.action == "message":
            target_id = _requested_topic_id(syllabus, request.message, state["active_topic_id"])
            if target_id:
                _, target_topic = ensure_topic_available(syllabus, state, target_id)
                target_ref = course_ref.collection("tutorTopics").document(target_id)
                target_conversation = _conversation(target_ref, state, transaction)
                user_text = request.message.strip()
                assistant_text = f"Sure, let's switch to {target_topic.title}. We can continue this lesson whenever you like."
                conversation["messages"] = [*conversation["messages"],
                    {"id": f"{request.operationId}-0-user", "role": "user", "text": user_text, "reply": None, "channel": "chat"}][-20:]
                target_conversation["messages"] = [*target_conversation["messages"],
                    {"id": f"{request.operationId}-1-assistant", "role": "assistant", "text": assistant_text, "reply": None, "channel": "chat"}][-20:]
                transaction.create(course_ref.collection("tutorHistory").document(
                    f"{request.operationId}-0-user"
                ), {
                    "topicId": request.topicId, "role": "user", "channel": "chat", "text": user_text,
                    "progressEpoch": state.get("progress_epoch", 0), "createdAt": firestore.SERVER_TIMESTAMP,
                })
                transaction.create(course_ref.collection("tutorHistory").document(
                    f"{request.operationId}-1-assistant"
                ), {
                    "topicId": target_id, "role": "assistant", "channel": "chat", "text": assistant_text,
                    "progressEpoch": state.get("progress_epoch", 0), "createdAt": firestore.SERVER_TIMESTAMP,
                })
                transaction.set(topic_ref, _conversation_document(conversation, state))
                transaction.set(target_ref, _conversation_document(target_conversation, state))
                state["active_topic_id"] = target_id
                state["pending"] = None
                state["operations"] = [*state["operations"], request.operationId][-100:]
                state["revision"] += 1
                transaction.set(state_ref, state)
                return {"tutor": None, "queue_notes": False}
        needs_model = request.action in ("start", "message", "explain", "repeat")
        write_conversation = True
        if request.action == "select":
            state["active_topic_id"] = request.topicId
            needs_model = False
        elif request.action == "restart":
            state["active_topic_id"] = ordered_topics(syllabus)[0][1].topic_id
            state["paused"] = False
            state["topic_status"] = {}
            state["confirmed_modules"] = []
            state["progress_epoch"] = state.get("progress_epoch", 0) + 1
            needs_model = False
            write_conversation = False
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
            conversation["answered_index"] = None
        elif request.action == "start" and current_concept_taught(conversation):
            needs_model = False
        if needs_model:
            if request.action != "message":
                conversation["answered_index"] = None
            elif current_concept_taught(conversation):
                conversation["answered_index"] = conversation["concept_index"]
            if request.action == "message":
                conversation["messages"] = [*conversation["messages"],
                    {"id": f"{request.operationId}-0-user", "role": "user", "text": request.message.strip(), "reply": None}][-20:]
                transaction.create(course_ref.collection("tutorHistory").document(
                    f"{request.operationId}-0-user"
                ), {
                    "topicId": request.topicId,
                    "role": "user",
                    "channel": "chat",
                    "text": request.message.strip(),
                    "progressEpoch": state.get("progress_epoch", 0),
                    "createdAt": firestore.SERVER_TIMESTAMP,
                })
            if state["topic_status"].get(request.topicId) != "completed":
                state["topic_status"][request.topicId] = "in_progress"
            state["pending"] = {"id": request.operationId, "started_at": datetime.now(timezone.utc)}
        else:
            state["pending"] = None
            state["operations"] = [*state["operations"], request.operationId][-100:]
        state["revision"] += 1
        transaction.set(state_ref, state)
        if write_conversation:
            transaction.set(topic_ref, _conversation_document(conversation, state))
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
    conversation = _conversation(topic_ref, state, transaction)
    if (state.get("pending") or {}).get("id") != request.operationId:
        raise HTTPException(409, "This tutor request is no longer active.")
    if reply is not None:
        conversation["concepts"] = reply.concepts
        if reply.intent == "redirect":
            conversation["taught_index"] = None
            conversation["answered_index"] = None
        else:
            conversation["taught_index"] = (
                conversation["concept_index"] if request.action == "message" else None
            )
        if request.action == "explain":
            explain_text = "Please explain again differently."
            conversation["messages"].append({"id": f"{request.operationId}-0-user", "role": "user", "text": explain_text, "reply": None})
            transaction.create(course_ref.collection("tutorHistory").document(
                f"{request.operationId}-0-user"
            ), {
                "topicId": request.topicId,
                "role": "user",
                "channel": "chat",
                "text": explain_text,
                "progressEpoch": state.get("progress_epoch", 0),
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
        conversation["messages"].append({"id": f"{request.operationId}-1-assistant", "role": "assistant", "text": "", "reply": reply.model_dump()})
        conversation["messages"] = conversation["messages"][-20:]
        transaction.create(course_ref.collection("tutorHistory").document(
            f"{request.operationId}-1-assistant"
        ), {
            "topicId": request.topicId,
            "role": "assistant",
            "channel": "chat",
            "text": _reply_history_text(reply),
            "reply": reply.model_dump(),
            "progressEpoch": state.get("progress_epoch", 0),
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        transaction.set(topic_ref, _conversation_document(conversation, state))
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
        logger.exception("Tutor state could not be loaded.")
        raise HTTPException(503, "I couldn't load your saved lesson just now. Your progress is safe; please refresh and try again.") from exc


@router.get("/history", response_model=TutorHistoryResponse)
def get_tutor_history(
    courseId: str = Query(min_length=1, max_length=150, pattern=r"^[^/]+$"),
    topicId: str = Query(pattern=r"^module-\d+-topic-\d+$"),
    before: str | None = Query(default=None, min_length=1, max_length=150, pattern=r"^[a-zA-Z0-9-]+$"),
    user: dict = Depends(get_current_user),
):
    try:
        _, course_ref, _, course, syllabus, _ = _context(courseId, user)
        state = _state(course_ref.collection("tutor").document("state"), course, syllabus)
        ensure_topic_available(syllabus, state, topicId)
        history = course_ref.collection("tutorHistory")
        query = history.order_by("createdAt", direction=firestore.Query.DESCENDING)
        if before:
            cursor = history.document(before).get()
            if not cursor.exists:
                raise HTTPException(409, "The saved conversation changed. Reload it to continue.")
            query = query.start_after(cursor)
        # Scan a bounded course-history page to avoid requiring a composite index.
        snapshots = list(query.limit(51).stream())
        messages = []
        for snapshot in reversed(snapshots[:50]):
            item = snapshot.to_dict() or {}
            if item.get("topicId") != topicId or item.get("progressEpoch", 0) != state.get("progress_epoch", 0):
                continue
            messages.append(TutorMessage(
                id=snapshot.id, role=item["role"], channel=item.get("channel", "chat"),
                text="" if item.get("reply") else item["text"], reply=item.get("reply"),
            ))
        return TutorHistoryResponse(
            messages=messages, next_cursor=snapshots[49].id if len(snapshots) > 50 else None,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning("Tutor history could not be validated.")
        raise HTTPException(409, "Your saved conversation needs review. Please reload your lesson.") from exc
    except Exception as exc:
        logger.exception("Tutor history could not be loaded.")
        raise HTTPException(503, "We couldn't load older messages just now. Please try again in a moment.") from exc


@firestore.transactional
def _cancel(transaction, context, request):
    _, course_ref, legacy_ref, course, syllabus, _ = context
    state_ref = course_ref.collection("tutor").document("state")
    _check_course(transaction, course_ref, legacy_ref, course["syllabusVersion"])
    state = _state(state_ref, course, syllabus, transaction)
    if request.operationId in state["operations"]:
        return
    if (state.get("pending") or {}).get("id") == request.operationId:
        state["pending"] = None
    # Also remember a stop that arrives before the original action is prepared.
    state["operations"] = [*state["operations"], request.operationId][-100:]
    state["revision"] += 1
    transaction.set(state_ref, state)


@router.post("/cancel", response_model=TutorStateResponse)
def cancel_tutor_response(request: TutorCancelRequest, user: dict = Depends(get_current_user)):
    try:
        context = _context(request.courseId, user)
        _cancel(context[0].transaction(), context, request)
        return _response(context)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Tutor response could not be stopped.")
        raise HTTPException(503, "We couldn't confirm the stop yet. Check your saved lesson before continuing.") from exc


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
                state = _state(context[1].collection("tutor").document("state"), context[3], context[4])
                learner_history = _recent_learning_history(context[1], state.get("progress_epoch", 0))
                course_progress = _course_progress_summary(context)
                reply = teach(context[4], module, topic, context[3], context[5], conversation,
                              request.action, request.message, request_id=request.operationId,
                              learner_history=learner_history, course_progress=course_progress)
            except Exception as exc:
                _finish(context[0].transaction(), context, request, None)
                if isinstance(exc, AIProviderError):
                    status = exc.status_code if exc.status_code in (429, 503, 504) else 502
                    if "deadline" in str(exc):
                        status = 504
                    logger.warning("Tutor provider failed with status %s.", exc.status_code or status)
                    detail = _friendly_ai_error(status)
                elif isinstance(exc, ValidationError):
                    issues = "; ".join(
                        f"{'.'.join(str(part) for part in issue['loc']) or 'response'}: {issue['type']}"
                        for issue in exc.errors(include_input=False, include_context=False)[:3]
                    )
                    logger.warning("Tutor reply failed validation: %s", issues)
                    status, detail = 502, _friendly_ai_error(502)
                else:
                    logger.exception("Tutor response was rejected.")
                    status, detail = 502, _friendly_ai_error(502)
                raise HTTPException(status, detail) from exc
            _finish(context[0].transaction(), context, request, reply)
        return _response(context)
    except HTTPException:
        raise
    except (ValidationError, ValueError) as exc:
        raise HTTPException(409, "Saved tutor data needs review; no completion was recorded.") from exc
    except Exception as exc:
        logger.exception("Tutor state could not be saved.")
        raise HTTPException(503, "The tutor couldn't save this update. Your progress is safe. Reload and try again.") from exc


@firestore.transactional
def _save_live_transcript(transaction, context, request):
    _, course_ref, legacy_ref, course, syllabus, _ = context
    state_ref = course_ref.collection("tutor").document("state")
    topic_ref = course_ref.collection("tutorTopics").document(request.topicId)
    _check_course(transaction, course_ref, legacy_ref, course["syllabusVersion"])
    state = _state(state_ref, course, syllabus, transaction)
    if request.progressEpoch != state.get("progress_epoch", 0):
        raise HTTPException(409, "This live session belongs to an earlier course progress state.")
    conversation = _conversation(topic_ref, state, transaction)
    if request.operationId in state.get("operations", []):
        return False
    if _busy(state) or state["paused"]:
        raise HTTPException(409, "Resume the lesson and wait for tutor actions to finish before saving this transcript.")
    try:
        _, topic = ensure_topic_available(syllabus, state, request.topicId)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    has_learner_turn = False
    has_assistant_turn = False
    for index, turn in enumerate(request.turns):
        saved_message = TutorMessage(id=f"{request.operationId}-{index}-{turn.role}",
                                     role=turn.role, text=turn.text, reply=None, channel="voice")
        conversation["messages"].append(saved_message.model_dump())
        transaction.create(course_ref.collection("tutorHistory").document(
            f"{request.operationId}-{index}-{turn.role}"
        ), {
            "topicId": request.topicId,
            "role": turn.role,
            "channel": "voice",
            "text": turn.text,
            "progressEpoch": state.get("progress_epoch", 0),
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        has_learner_turn = has_learner_turn or turn.role == "user"
        has_assistant_turn = has_assistant_turn or turn.role == "assistant"
    conversation["messages"] = conversation["messages"][-20:]
    if has_learner_turn and has_assistant_turn and current_concept_taught(conversation):
        conversation["taught_index"] = conversation["concept_index"]
        conversation["answered_index"] = conversation["concept_index"]
    if state["topic_status"].get(request.topicId) != "completed":
        state["topic_status"][request.topicId] = "in_progress"
    requested_switch = _requested_topic_id(
        syllabus,
        " ".join(turn.text for turn in request.turns if turn.role == "user"),
        state["active_topic_id"],
    )
    if requested_switch:
        state["active_topic_id"] = requested_switch
    state["revision"] += 1
    state["operations"] = [*state.get("operations", []), request.operationId][-100:]
    transaction.set(state_ref, state)
    transaction.set(topic_ref, _conversation_document(conversation, state))
    return True


@router.post("/live/session")
def create_live_tutor_session(request: TutorLiveSessionRequest,
                              user: dict = Depends(get_current_user)):
    if not GEMINI_LIVE_ENABLED:
        raise HTTPException(503, "Live voice is unavailable right now. You can continue learning in chat.")
    try:
        context = _context(request.courseId, user)
        tutor_context = _live_course_context(context, request.topicId)
        instruction = build_live_instruction(tutor_context)
        token = create_live_access_token(instruction)
        return {
            "accessToken": token,
            "model": GEMINI_LIVE_MODEL,
            "config": live_client_config(instruction),
        }
    except HTTPException:
        raise
    except UsageLimitError as exc:
        logger.warning("Live tutor usage guard rejected the session: %s", exc)
        raise HTTPException(exc.status_code, str(exc)) from exc
    except AIProviderError as exc:
        status = exc.status_code if exc.status_code in (429, 503, 504) else 502
        logger.warning("Live tutor provider failed with status %s.", exc.status_code or status)
        if status == 429:
            detail = "Live voice has reached its AI request limit for now. Your progress is safe; try again later or use chat."
        elif status == 504:
            detail = "Live voice took too long to connect. Your progress is safe; please try again."
        else:
            detail = "Live voice is temporarily unavailable. Your progress is safe; you can continue in chat."
        raise HTTPException(status, detail) from exc
    except Exception as exc:
        logger.exception("Live tutor context could not be loaded.")
        raise HTTPException(503, "I couldn't prepare your live lesson just now. Your progress is safe; please try again or use chat.") from exc


@router.post("/live/transcript", response_model=TutorStateResponse)
def save_live_tutor_transcript(request: TutorLiveTranscriptRequest,
                               user: dict = Depends(get_current_user)):
    try:
        context = _context(request.courseId, user)
        saved = _save_live_transcript(context[0].transaction(), context, request)
        if saved and request.usage is not None:
            log_live_usage(
                request_id=request.operationId,
                model=GEMINI_LIVE_MODEL,
                usage=request.usage.model_dump(),
                session_reserved_cost_usd=GEMINI_LIVE_SESSION_COST_RESERVE_USD,
            )
        return _response(context)
    except HTTPException:
        raise
    except (ValidationError, ValueError) as exc:
        logger.warning("Live tutor transcript validation failed: %s", type(exc).__name__)
        raise HTTPException(409, "I couldn't save that voice turn. Your progress is safe; please retry or continue in chat.") from exc
    except Exception as exc:
        logger.exception("Live tutor transcript could not be saved.")
        raise HTTPException(503, "I couldn't save that voice turn just now. Your saved progress is safe; retry or continue in chat.") from exc
