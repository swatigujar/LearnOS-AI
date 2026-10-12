export const maxDuration = 150;

function authorized(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization : null;
}

function backendUrl() {
  return (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
}

export async function GET(request: Request) {
  const authorization = authorized(request);
  if (!authorization) return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const courseId = query.get("courseId") ?? "";
  const topicId = query.get("topicId") ?? "";
  const syllabusVersion = query.get("syllabusVersion") ?? "";
  try {
    const response = await fetch(`${backendUrl()}/api/mock-test/bank?courseId=${encodeURIComponent(courseId)}&topicId=${encodeURIComponent(topicId)}&syllabusVersion=${encodeURIComponent(syllabusVersion)}`, {
      headers: { Authorization: authorization }, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ detail: "Saved question-bank status is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const authorization = authorized(request);
  if (!authorization) return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  let body: { action?: string; courseId?: string; topicId?: string; syllabusVersion?: number; attemptId?: string; answers?: Record<string, number> };
  try { body = await request.json(); }
  catch { return Response.json({ detail: "Invalid JSON request." }, { status: 400 }); }
  const path = body.action === "start" ? "start" : body.action === "submit" ? "submit" : null;
  if (!path) return Response.json({ detail: "Unsupported mock-test action." }, { status: 400 });
  const payload = path === "start"
    ? { courseId: body.courseId, topicId: body.topicId, syllabusVersion: body.syllabusVersion, attemptId: body.attemptId }
    : { courseId: body.courseId, topicId: body.topicId, syllabusVersion: body.syllabusVersion, answers: body.answers ?? {} };
  try {
    const response = await fetch(`${backendUrl()}/api/mock-test/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(145_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch (error) {
    return Response.json({ detail: error instanceof Error && error.name === "TimeoutError"
      ? "Preparing the saved topic test timed out. Check its status before trying again."
      : "The mock-test backend is unavailable." }, { status: error instanceof Error && error.name === "TimeoutError" ? 504 : 503 });
  }
}
