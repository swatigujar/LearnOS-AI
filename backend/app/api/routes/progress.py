from fastapi import APIRouter, Depends, HTTPException

from app.api.dependencies import get_current_user
from app.api.schemas.progress import UserProgressSummary
from app.core.firebase import get_firestore_client
from app.services.course_progress import calculate_course_progress, summarize_progress

router = APIRouter(prefix="/api/progress", tags=["progress"])


@router.get("/summary", response_model=UserProgressSummary)
def get_progress_summary(user: dict = Depends(get_current_user)):
    user_id = user.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="Firebase token has no user ID.")

    database = get_firestore_client()
    courses_by_id = {}
    goal_snapshots = database.collection(f"users/{user_id}/learningGoals").get() or []
    active_goal_ids = {getattr(snapshot, "id", None) for snapshot in goal_snapshots}
    active_goal_ids.discard(None)
    for collection_name, snapshots in (
        ("learningGoals", goal_snapshots),
        ("courses", database.collection(f"users/{user_id}/courses").get() or []),
    ):
        for snapshot in snapshots:
            course_id = getattr(snapshot, "id", None)
            if not course_id:
                continue
            saved_data = snapshot.to_dict() or {}
            existing_data = courses_by_id.get(course_id, {})
            courses_by_id[course_id] = (
                {**saved_data, **existing_data}
                if collection_name == "learningGoals"
                else {**existing_data, **saved_data}
            )

    courses_by_id = {
        course_id: course_data
        for course_id, course_data in courses_by_id.items()
        if not isinstance(course_data.get("sourceLearningGoalId"), str)
        or not course_data["sourceLearningGoalId"]
        or course_data["sourceLearningGoalId"] in active_goal_ids
    }

    courses = []
    for course_id, course_data in courses_by_id.items():
        course_ref = database.document(f"users/{user_id}/courses/{course_id}")
        syllabus_version = course_data.get("syllabusVersion")
        syllabus_data = None
        if type(syllabus_version) is int and syllabus_version > 0:
            syllabus_snapshot = course_ref.collection("syllabus").document(f"v{syllabus_version}").get()
            if syllabus_snapshot.exists:
                syllabus_data = syllabus_snapshot.to_dict()

        if syllabus_data is not None:
            syllabus_status = "ready"
        elif course_data.get("syllabusStatus") in ("generating", "failed"):
            syllabus_status = course_data["syllabusStatus"]
        elif course_data.get("syllabusStatus") == "ready":
            syllabus_status = "unavailable"
        else:
            syllabus_status = "not_generated"

        tutor_state_snapshot = course_ref.collection("tutor").document("state").get()
        tutor_state = tutor_state_snapshot.to_dict() if tutor_state_snapshot.exists else None

        result = calculate_course_progress(course_data, syllabus_data, tutor_state)
        result["courseId"] = course_id
        result["syllabusStatus"] = syllabus_status
        courses.append(result)

    return summarize_progress(courses)
