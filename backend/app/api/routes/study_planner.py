from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from firebase_admin import firestore

from app.api.dependencies import get_current_user
from app.api.schemas.study_planner import (
    LessonCompletionActivity,
    PlannerCourse,
    PlannerLesson,
    PlannerOverview,
    PlannerSession,
    StudySessionCreate,
    StudySessionStatusUpdate,
    StudySessionUpdate,
    WeeklyActivityDay,
    WeeklyGoalUpdate,
)
from app.core.firebase import get_firestore_client

router = APIRouter(prefix="/api/planner", tags=["study planner"])


def _user_id(user):
    user_id = user.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")
    return user_id


def _utc_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if hasattr(value, "to_datetime"):
        try:
            return _utc_datetime(value.to_datetime())
        except Exception:
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return _utc_datetime(parsed) if parsed.tzinfo else None
        except ValueError:
            return None
    return None


def _iso(value):
    parsed = _utc_datetime(value)
    return parsed.isoformat().replace("+00:00", "Z") if parsed else None


def _user_course_data(database, user_id):
    courses = {}
    active_goal_ids = set()
    for collection_name in ("learningGoals", "courses"):
        snapshots = database.collection(f"users/{user_id}/{collection_name}").get() or []
        for snapshot in snapshots:
            course_id = getattr(snapshot, "id", None)
            if not course_id:
                continue
            saved = snapshot.to_dict() or {}
            if collection_name == "learningGoals":
                active_goal_ids.add(course_id)
            existing = courses.get(course_id, {})
            courses[course_id] = {**existing, **saved}
    return {
        course_id: data
        for course_id, data in courses.items()
        if not isinstance(data.get("sourceLearningGoalId"), str)
        or not data["sourceLearningGoalId"]
        or data["sourceLearningGoalId"] in active_goal_ids
    }


def _course_syllabus(database, user_id, course_id, course_data):
    version = course_data.get("syllabusVersion")
    course_ref = database.document(f"users/{user_id}/courses/{course_id}")
    syllabus = None
    if type(version) is int and version > 0:
        snapshot = course_ref.collection("syllabus").document(f"v{version}").get()
        if snapshot.exists:
            syllabus = snapshot.to_dict()
    return course_ref, syllabus


def _syllabus_status(course_data, syllabus):
    if syllabus is not None:
        return "ready"
    status = course_data.get("syllabusStatus")
    if status in ("generating", "failed"):
        return status
    return "unavailable" if status == "ready" else "not_generated"


def _course_lessons(syllabus, tutor_state):
    if not isinstance(syllabus, dict):
        return []
    statuses = (tutor_state or {}).get("topic_status", {}) if isinstance(tutor_state, dict) else {}
    if not isinstance(statuses, dict):
        statuses = {}
    lessons = []
    for module in syllabus.get("modules", []):
        if not isinstance(module, dict):
            continue
        for topic in module.get("topics", []):
            if not isinstance(topic, dict) or not topic.get("topic_id"):
                continue
            status = statuses.get(topic["topic_id"], "not_started")
            if status not in ("not_started", "in_progress", "completed"):
                status = "not_started"
            lessons.append(PlannerLesson(
                lessonId=topic["topic_id"],
                title=topic.get("title") or "Untitled lesson",
                moduleTitle=module.get("title") or "Module",
                status=status,
            ))
    return lessons


def _validate_course(database, user_id, course_id, lesson_id=None):
    courses = _user_course_data(database, user_id)
    course_data = courses.get(course_id)
    if course_data is None:
        raise HTTPException(status_code=404, detail="Course not found for this user.")
    course_ref, syllabus = _course_syllabus(database, user_id, course_id, course_data)
    lesson = None
    if lesson_id:
        lesson = next((item for item in _course_lessons(syllabus, None) if item.lessonId == lesson_id), None)
        if lesson is None:
            raise HTTPException(status_code=422, detail="Select a lesson from this user's saved syllabus.")
    title = (course_data.get("courseName") or course_data.get("courseTrack")
             or course_data.get("goalText") or course_data.get("title") or "Untitled course")
    return course_ref, course_data, title, lesson


def _session_record(snapshot, courses):
    data = snapshot.to_dict() or {}
    course_id = data.get("courseId")
    course = courses.get(course_id, {})
    return PlannerSession(
        sessionId=snapshot.id,
        courseId=course_id or "",
        courseTitle=(course.get("courseName") or course.get("courseTrack")
                     or course.get("goalText") or course.get("title") or "Course unavailable"),
        lessonId=data.get("lessonId"),
        lessonTitle=data.get("lessonTitle"),
        startAt=_iso(data.get("startAt")) or "",
        durationMinutes=data.get("durationMinutes", 0),
        note=data.get("note", ""),
        status=data.get("status", "scheduled"),
    )


def _validate_range(start_at, end_at):
    if (not isinstance(start_at, datetime) or start_at.tzinfo is None or start_at.utcoffset() is None
            or not isinstance(end_at, datetime) or end_at.tzinfo is None or end_at.utcoffset() is None):
        raise HTTPException(status_code=422, detail="Calendar range boundaries must include a time zone.")
    start_utc = _utc_datetime(start_at)
    end_utc = _utc_datetime(end_at)
    if start_utc is None or end_utc is None or end_utc <= start_utc:
        raise HTTPException(status_code=422, detail="The calendar range is invalid.")
    if end_utc - start_utc > timedelta(days=62):
        raise HTTPException(status_code=422, detail="Calendar ranges cannot exceed 62 days.")
    return start_utc, end_utc


def _validated_zone(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise HTTPException(status_code=422, detail="Choose a valid time zone.")
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="Choose a valid time zone.") from exc


def _local_week_window(now, zone):
    local_now = now.astimezone(zone)
    week_start = local_now.date() - timedelta(days=local_now.weekday())
    week_end = week_start + timedelta(days=7)
    start_utc = datetime.combine(week_start, time.min, tzinfo=zone).astimezone(timezone.utc)
    end_utc = datetime.combine(week_end, time.min, tzinfo=zone).astimezone(timezone.utc)
    return week_start, start_utc, end_utc


def _weekly_activity_counts(weekly_events, week_start, zone):
    return [(
        (week_start + timedelta(days=offset)).isoformat(),
        sum(1 for completed_at in weekly_events if completed_at.astimezone(zone).date() == week_start + timedelta(days=offset)),
    ) for offset in range(7)]


@router.get("/overview", response_model=PlannerOverview)
def get_planner_overview(
    startAt: datetime,
    endAt: datetime,
    timeZone: str | None = Query(default=None, min_length=1, max_length=100),
    user: dict = Depends(get_current_user),
):
    user_id = _user_id(user)
    start_utc, end_utc = _validate_range(startAt, endAt)
    zone = _validated_zone(timeZone) if timeZone is not None else timezone.utc

    week_start, week_start_utc, week_end_utc = _local_week_window(datetime.now(timezone.utc), zone)

    database = get_firestore_client()
    course_data = _user_course_data(database, user_id)
    courses = []
    completion_events = []
    weekly_events = {}
    for course_id, data in course_data.items():
        course_ref, syllabus = _course_syllabus(database, user_id, course_id, data)
        tutor_snapshot = course_ref.collection("tutor").document("state").get()
        tutor_state = tutor_snapshot.to_dict() if tutor_snapshot.exists else None
        courses.append(PlannerCourse(
            courseId=course_id,
            title=(data.get("courseName") or data.get("courseTrack") or data.get("goalText")
                   or data.get("title") or "Untitled course"),
            syllabusStatus=_syllabus_status(data, syllabus),
            activeLessonId=(tutor_state or {}).get("active_topic_id") if isinstance(tutor_state, dict) else None,
            lessons=_course_lessons(syllabus, tutor_state),
        ))
        for event_snapshot in course_ref.collection("tutorCompletions").get() or []:
            event = event_snapshot.to_dict() or {}
            completed_at = _utc_datetime(event.get("completedAt"))
            if completed_at is None:
                continue
            if start_utc <= completed_at < end_utc:
                completion_events.append(LessonCompletionActivity(
                    eventId=event_snapshot.id,
                    courseId=course_id,
                    courseTitle=courses[-1].title,
                    lessonId=event.get("topicId", ""),
                    lessonTitle=event.get("lessonTitle", "Completed lesson"),
                    moduleTitle=event.get("moduleTitle", ""),
                    completedAt=_iso(completed_at),
                ))
            if week_start_utc <= completed_at < week_end_utc:
                weekly_events[(course_id, event_snapshot.id)] = completed_at

    weekly_activity = [
        WeeklyActivityDay(date=day, completedLessons=count)
        for day, count in _weekly_activity_counts(weekly_events.values(), week_start, zone)
    ]

    session_snapshots = database.collection(f"users/{user_id}/studySessions").get() or []
    sessions = []
    for snapshot in session_snapshots:
        session = _session_record(snapshot, course_data)
        if session.courseId not in course_data:
            continue
        start = _utc_datetime(session.startAt)
        if start and start_utc <= start < end_utc:
            sessions.append(session)
    sessions.sort(key=lambda item: item.startAt)
    completion_events.sort(key=lambda item: item.completedAt)

    settings = database.document(f"users/{user_id}/learningSettings/planner").get().to_dict() or {}
    weekly_target = settings.get("weeklyLessonTarget")
    if type(weekly_target) is not int or not 1 <= weekly_target <= 100:
        weekly_target = None

    return PlannerOverview(
        courses=courses,
        sessions=sessions,
        completions=completion_events,
        weeklyTarget=weekly_target,
        weeklyCompletedLessons=len(weekly_events),
        weeklyActivity=weekly_activity,
    )


@router.post("/sessions", response_model=PlannerSession, status_code=201)
def create_study_session(request: StudySessionCreate, user: dict = Depends(get_current_user)):
    user_id = _user_id(user)
    start_at = _utc_datetime(request.startAt)
    if start_at is None or start_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="Choose a future session start time.")
    database = get_firestore_client()
    _, _, course_title, lesson = _validate_course(database, user_id, request.courseId, request.lessonId)
    session_id = UUID(request.operationId).hex
    session_ref = database.document(f"users/{user_id}/studySessions/{session_id}")
    record = {
        "courseId": request.courseId,
        "lessonId": request.lessonId,
        "lessonTitle": lesson.title if lesson else None,
        "startAt": start_at,
        "durationMinutes": request.durationMinutes,
        "note": request.note.strip(),
        "status": "scheduled",
        "createdAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    try:
        session_ref.create(record)
    except Exception as exc:
        existing = session_ref.get()
        existing_data = existing.to_dict() if existing.exists else None
        if not existing_data or any(existing_data.get(key) != value for key, value in record.items()
                                    if key not in ("createdAt", "updatedAt")):
            raise HTTPException(status_code=503, detail="The study session could not be saved.") from exc
        return _session_record(existing, {request.courseId: {"courseName": course_title}})
    snapshot = session_ref.get()
    return _session_record(snapshot, {request.courseId: {"courseName": course_title}})


@router.patch("/sessions/{session_id}", response_model=PlannerSession)
def update_study_session(session_id: str, request: StudySessionUpdate, user: dict = Depends(get_current_user)):
    user_id = _user_id(user)
    updates = request.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="Provide at least one session field to update.")
    database = get_firestore_client()
    session_ref = database.document(f"users/{user_id}/studySessions/{session_id}")
    snapshot = session_ref.get()
    data = snapshot.to_dict() if snapshot.exists else None
    if not data:
        raise HTTPException(status_code=404, detail="Study session not found.")
    if data.get("status") != "scheduled":
        raise HTTPException(status_code=409, detail="Only scheduled sessions can be edited.")
    course_id = updates.get("courseId", data.get("courseId"))
    lesson_id = updates.get("lessonId", data.get("lessonId"))
    _, _, course_title, lesson = _validate_course(database, user_id, course_id, lesson_id)
    if "startAt" in updates:
        start_at = _utc_datetime(updates["startAt"])
        if start_at is None or start_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=422, detail="Choose a future session start time.")
        updates["startAt"] = start_at
    if "lessonId" in updates or "courseId" in updates:
        updates["lessonTitle"] = lesson.title if lesson else None
    updates["updatedAt"] = firestore.SERVER_TIMESTAMP
    session_ref.update(updates)
    return _session_record(session_ref.get(), {course_id: {"courseName": course_title}})


@router.patch("/sessions/{session_id}/status", response_model=PlannerSession)
def update_study_session_status(session_id: str, request: StudySessionStatusUpdate,
                                user: dict = Depends(get_current_user)):
    user_id = _user_id(user)
    database = get_firestore_client()
    session_ref = database.document(f"users/{user_id}/studySessions/{session_id}")
    snapshot = session_ref.get()
    data = snapshot.to_dict() if snapshot.exists else None
    if not data:
        raise HTTPException(status_code=404, detail="Study session not found.")
    if data.get("status") != "scheduled":
        raise HTTPException(status_code=409, detail="This session is no longer scheduled.")
    session_ref.update({"status": request.status, "updatedAt": firestore.SERVER_TIMESTAMP})
    courses = _user_course_data(database, user_id)
    return _session_record(session_ref.get(), courses)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_study_session(session_id: str, user: dict = Depends(get_current_user)):
    user_id = _user_id(user)
    database = get_firestore_client()
    session_ref = database.document(f"users/{user_id}/studySessions/{session_id}")
    snapshot = session_ref.get()
    data = snapshot.to_dict() if snapshot.exists else None
    if not data:
        raise HTTPException(status_code=404, detail="Study session not found.")
    if data.get("status") == "completed":
        raise HTTPException(status_code=409, detail="Completed sessions cannot be deleted.")
    session_ref.delete()


@router.put("/weekly-goal")
def update_weekly_goal(request: WeeklyGoalUpdate, user: dict = Depends(get_current_user)):
    user_id = _user_id(user)
    reference = get_firestore_client().document(f"users/{user_id}/learningSettings/planner")
    if request.weeklyTarget is None:
        reference.set({"weeklyLessonTarget": firestore.DELETE_FIELD, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
        return {"weeklyTarget": None}
    reference.set({"weeklyLessonTarget": request.weeklyTarget, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return {"weeklyTarget": request.weeklyTarget}
