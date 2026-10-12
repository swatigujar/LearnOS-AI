import {
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type DocumentSnapshot,
} from "firebase/firestore";
import { db } from "./firebase";

export type LearningGoalInput = {
  courseName: string;
  goalText: string;
  skillLevel: "beginner" | "intermediate" | "advanced";
  timelineType: "days" | "date";
  targetDays: number | null;
  targetDate: string | null;
  studyHoursPerDay: number;
  preferredLearningStyle: string | null;
  additionalRequirements: string | null;
};

export async function createLearningGoal(userId: string, input: LearningGoalInput) {
  const goalRef = doc(collection(db, "users", userId, "learningGoals"));
  await setDoc(goalRef, {
    courseName: input.courseName.trim(),
    goalText: input.goalText.trim(),
    skillLevel: input.skillLevel,
    timelineType: input.timelineType,
    targetDays: input.targetDays,
    targetDate: input.targetDate,
    studyHoursPerDay: input.studyHoursPerDay,
    preferredLearningStyle: input.preferredLearningStyle?.trim() || null,
    additionalRequirements: input.additionalRequirements?.trim() || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return goalRef.id;
}

export async function getLearningGoals(userId: string) {
  const goalsSnapshot = await getDocs(collection(db, "users", userId, "learningGoals"));
  return goalsSnapshot.docs.map(mapGoal);
}

export type LearningGoal = {
  id: string;
  courseName: string;
  goalText: string;
  skillLevel?: string;
  timelineType?: "days" | "date";
  targetDays?: number | null;
  targetDate?: string | null;
  studyHoursPerDay?: number;
  preferredLearningStyle?: string | null;
  additionalRequirements?: string | null;
  timelinePriority?: "standard" | "accelerated";
  timelineUpdated?: boolean;
};

export function mapGoal(snapshot: DocumentSnapshot<DocumentData>): LearningGoal {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    courseName: data.courseName ?? data.courseTrack ?? data.goalText ?? data.title ?? "Untitled course",
    goalText: data.goalText ?? data.title ?? "Untitled goal",
    skillLevel: data.skillLevel,
    timelineType: data.timelineType,
    targetDays: data.targetDays ?? null,
    targetDate: data.targetDate ?? null,
    studyHoursPerDay: data.studyHoursPerDay,
    preferredLearningStyle: data.preferredLearningStyle ?? null,
    additionalRequirements: data.additionalRequirements ?? null,
    timelinePriority: data.timelinePriority,
    timelineUpdated: data.timelineUpdated,
  };
}

export async function getLearningGoal(userId: string, goalId: string) {
  const goalSnapshot = await getDoc(doc(db, "users", userId, "learningGoals", goalId));
  return goalSnapshot.exists() ? mapGoal(goalSnapshot) : null;
}

export async function deleteLearningGoal(userId: string, goalId: string) {
  await deleteDoc(doc(db, "users", userId, "learningGoals", goalId));
}

export type LearningTimelineInput = {
  timelineType: "days" | "date";
  targetDays: number | null;
  targetDate: string | null;
  studyHoursPerDay: number;
};

export function timelineDurationInDays(timeline: Pick<LearningTimelineInput, "timelineType" | "targetDays" | "targetDate">) {
  if (timeline.timelineType === "days") return timeline.targetDays;
  if (!timeline.targetDate) return null;

  const targetTime = Date.parse(`${timeline.targetDate}T00:00:00Z`);
  if (!Number.isFinite(targetTime)) return null;
  const today = new Date();
  const todayTime = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.ceil((targetTime - todayTime) / 86_400_000));
}

export async function updateLearningGoalTimeline(
  userId: string,
  goalId: string,
  input: LearningTimelineInput,
) {
  const goalRef = doc(db, "users", userId, "learningGoals", goalId);
  const goalSnapshot = await getDoc(goalRef);
  if (!goalSnapshot.exists()) throw new Error("This course no longer exists.");

  const savedGoal = mapGoal(goalSnapshot);
  const previousDuration = savedGoal.timelineType
    ? timelineDurationInDays({
      timelineType: savedGoal.timelineType,
      targetDays: savedGoal.targetDays ?? null,
      targetDate: savedGoal.targetDate ?? null,
    })
    : null;
  const nextDuration = timelineDurationInDays(input);
  const accelerated = previousDuration !== null
    && nextDuration !== null
    && nextDuration < previousDuration;

  await updateDoc(goalRef, {
    timelineType: input.timelineType,
    targetDays: input.targetDays,
    targetDate: input.targetDate,
    studyHoursPerDay: input.studyHoursPerDay,
    timelineUpdated: true,
    timelinePriority: accelerated ? "accelerated" : "standard",
    prioritizeFoundationalTopics: accelerated,
    timelineUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return { accelerated };
}
