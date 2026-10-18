export type MockQuestion = { questionId: string; prompt: string; options: string[] };
export type MockBank = {
  status: "missing" | "pending" | "ready" | "failed" | "budget_blocked" | "uncertain";
  attemptId?: string | null;
  questions: MockQuestion[];
};
export type MockResult = {
  attemptId: string;
  courseId: string;
  courseTitle: string;
  topicId: string;
  topicTitle: string;
  moduleTitle: string;
  syllabusVersion: number;
  completedAt: string | null;
  total: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  percentage: number;
  questions: (MockQuestion & {
    selectedIndex: number | null; correctIndex: number; explanation: string; correct: boolean;
  })[];
};

export function summarizeMockTopics(attempts: MockResult[]) {
  const topics = new Map<string, {
    topicId: string; topicTitle: string; moduleTitle: string; syllabusVersion: number;
    attempts: number; correct: number; total: number; bestPercentage: number; latestPercentage: number;
  }>();
  for (const attempt of attempts) {
    const key = `${attempt.syllabusVersion}:${attempt.topicId}`;
    const current = topics.get(key) ?? {
      topicId: attempt.topicId, topicTitle: attempt.topicTitle, moduleTitle: attempt.moduleTitle,
      syllabusVersion: attempt.syllabusVersion, attempts: 0, correct: 0, total: 0,
      bestPercentage: 0, latestPercentage: attempt.percentage,
    };
    current.attempts += 1;
    current.correct += attempt.correct;
    current.total += attempt.total;
    current.bestPercentage = Math.max(current.bestPercentage, attempt.percentage);
    topics.set(key, current);
  }
  return [...topics.values()].map((topic) => ({
    ...topic, percentage: topic.total ? Math.round(topic.correct / topic.total * 100) : 0,
  }));
}

export function friendlyMockError(status: number) {
  if (status === 401) return "Please sign in again to continue your mock test.";
  if (status === 404) return "We couldn't find this saved course or test. Return to your course and try again.";
  if (status === 409) return "This test or syllabus has changed. Check the saved test before continuing.";
  if (status === 422) return "We couldn't accept those answers. Check your selections and submit again.";
  if (status === 429) return "Question generation needs a short break. Please try again later.";
  return "We couldn't finish that step just now. Your selections are still on this page. Check the saved test or try again in a moment.";
}

export async function requestMock<T>(token: string, query: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/mock-test${query}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store", signal: AbortSignal.timeout(body ? 150_000 : 25_000),
    });
  } catch {
    throw new Error("This is taking longer than expected. Your selections are still here. Check the saved test before starting another.");
  }
  if (!response.ok) throw new Error(friendlyMockError(response.status));
  try { return await response.json() as T; }
  catch { throw new Error("We couldn't read the saved test just now. Please check its status and try again."); }
}
