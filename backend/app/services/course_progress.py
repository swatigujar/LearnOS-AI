from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from typing import Any


def _resolve_topic_order(syllabus_data: Any):
    if not isinstance(syllabus_data, dict):
        return []
    modules = syllabus_data.get("modules") or []
    if not isinstance(modules, list):
        return []
    ordered = []
    seen_topic_ids = set()
    for module in modules:
        if not isinstance(module, dict):
            continue
        topics = module.get("topics") or []
        if not isinstance(topics, list):
            continue
        for topic in topics:
            if not isinstance(topic, dict):
                continue
            topic_id = topic.get("topic_id")
            if not isinstance(topic_id, str) or not topic_id.strip() or topic_id in seen_topic_ids:
                continue
            seen_topic_ids.add(topic_id)
            ordered.append({
                "topic_id": topic_id,
                "title": topic.get("title") or "Untitled lesson",
                "module_title": module.get("title") or "Module",
            })
    return ordered


def _coerce_datetime(value: Any):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if hasattr(value, "to_utc_datetime"):
        try:
            return value.to_utc_datetime().isoformat()
        except Exception:
            return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        normalized = stripped.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(normalized).astimezone(timezone.utc).isoformat()
        except ValueError:
            return stripped
    return None


def _latest_activity_value(activity_values):
    valid = [value for value in activity_values if value]
    if not valid:
        return None
    parsed = []
    for value in valid:
        converted = _coerce_datetime(value)
        if converted is not None:
            parsed.append((converted, value))
    if not parsed:
        return None
    return max(parsed, key=lambda item: item[0])[0]


def calculate_course_progress(course_data: dict | None, syllabus_data: dict | None, tutor_state: dict | None):
    course = course_data or {}
    title = (
        course.get("courseName")
        or course.get("courseTrack")
        or course.get("goalText")
        or course.get("title")
        or "Untitled course"
    )
    ordered_topics = _resolve_topic_order(syllabus_data)
    total_lessons = len(ordered_topics)
    topic_status = (tutor_state or {}).get("topic_status", {}) if isinstance(tutor_state, dict) else {}
    if not isinstance(topic_status, dict):
        topic_status = {}
    completed = sum(1 for topic in ordered_topics if topic_status.get(topic["topic_id"]) == "completed")
    in_progress = sum(1 for topic in ordered_topics if topic_status.get(topic["topic_id"]) == "in_progress")
    if total_lessons == 0:
        completion_rate = 0
        status = "not_started"
        current_lesson = None
        next_lesson = None
    elif completed == total_lessons:
        completion_rate = 100
        status = "completed"
        current_lesson = ordered_topics[-1]["title"] if ordered_topics else None
        next_lesson = None
    elif completed > 0 or in_progress > 0:
        completion_rate = round(completed / total_lessons * 100)
        status = "in_progress"
        current_lesson = None
        next_lesson = None
        active_topic_id = (tutor_state or {}).get("active_topic_id") if isinstance(tutor_state, dict) else None
        if active_topic_id:
            for topic in ordered_topics:
                if topic["topic_id"] == active_topic_id and topic_status.get(active_topic_id) != "completed":
                    current_lesson = topic["title"]
                    break
        if current_lesson is None:
            for topic in ordered_topics:
                if topic_status.get(topic["topic_id"]) == "in_progress":
                    current_lesson = topic["title"]
                    break
        for topic in ordered_topics:
            if topic_status.get(topic["topic_id"]) != "completed":
                next_lesson = topic["title"]
                break
    else:
        completion_rate = 0
        status = "not_started"
        current_lesson = None
        next_lesson = ordered_topics[0]["title"] if ordered_topics else None

    activity_candidates = []
    for key in ("lastStudyAt", "lastStudiedAt", "lastStudyDate", "lastActivityAt", "lastActivityDate", "studyStartedAt"):
        value = course.get(key)
        if value is not None:
            activity_candidates.append(value)
    if isinstance(tutor_state, dict):
        for key in ("lastStudyAt", "lastStudiedAt", "lastStudyDate", "lastActivityAt", "lastActivityDate", "studyStartedAt"):
            value = tutor_state.get(key)
            if value is not None:
                activity_candidates.append(value)
    last_studied_at = _latest_activity_value(activity_candidates)

    study_sessions = _recorded_metric(
        (tutor_state, course),
        ("studySessions", "study_session_count", "sessionsCount"),
        integer=True,
    )
    total_minutes = _recorded_metric(
        (tutor_state, course),
        ("totalMinutesStudied", "minutesStudied", "total_study_minutes"),
        integer=False,
    )

    return {
        "courseId": course.get("courseId", ""),
        "title": title,
        "completionRate": completion_rate,
        "completedLessons": completed,
        "totalLessons": total_lessons,
        "currentLesson": current_lesson,
        "nextLesson": next_lesson,
        "lastStudiedAt": last_studied_at,
        "studySessions": study_sessions,
        "totalMinutesStudied": total_minutes,
        "status": status,
    }


def _recorded_metric(sources, keys, *, integer):
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            if integer and type(value) is int and value >= 0:
                return value
            if not integer and isinstance(value, (int, float)) and not isinstance(value, bool):
                if isfinite(value) and value >= 0:
                    return int(value)
    return None


def summarize_progress(course_results):
    total_courses = len(course_results)
    total_lessons = sum(item["totalLessons"] for item in course_results)
    completed_lessons = sum(item["completedLessons"] for item in course_results)
    overall_progress = round((completed_lessons / total_lessons) * 100, 2) if total_lessons else 0.0
    courses_in_progress = sum(1 for item in course_results if item["status"] == "in_progress")
    completed_courses = sum(1 for item in course_results if item["status"] == "completed")
    activity_candidates = [item.get("lastStudiedAt") for item in course_results if item.get("lastStudiedAt")]
    latest_activity = max(activity_candidates, key=lambda value: value) if activity_candidates else None
    session_counts = [item["studySessions"] for item in course_results if item.get("studySessions") is not None]
    study_minutes = [item["totalMinutesStudied"] for item in course_results if item.get("totalMinutesStudied") is not None]
    activity_summary = None
    if latest_activity or session_counts or study_minutes:
        activity_summary = {
            "lastStudyDate": latest_activity,
            "studySessions": sum(session_counts) if session_counts else None,
            "totalMinutesStudied": sum(study_minutes) if study_minutes else None,
        }
    return {
        "overallProgress": overall_progress,
        "coursesInProgress": courses_in_progress,
        "completedCourses": completed_courses,
        "totalCourses": total_courses,
        "lastStudyActivity": activity_summary,
        "courses": course_results,
    }
