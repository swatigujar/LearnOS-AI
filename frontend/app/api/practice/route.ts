function authorized(request: Request) {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value : null;
}

function backendUrl() {
  return (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
}

async function forward(request: Request, path: string, method: "GET" | "POST", body?: unknown, timeoutMs = 20_000) {
  const authorization = authorized(request);
  if (!authorization) return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  try {
    const response = await fetch(`${backendUrl()}/api/practice/${path}`, {
      method,
      headers: { Authorization: authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ detail: "Practice is unavailable right now. Please try again." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const action = query.get("action");
  if (action === "courses" || action === "attempts") return forward(request, action, "GET");
  if (action === "courseCatalog") return forward(request, "courses/catalog", "GET");
  if (action === "courseTopics") {
    const courseId = query.get("courseId") ?? "";
    if (!courseId || courseId.includes("/")) return Response.json({ detail: "Choose a valid course." }, { status: 400 });
    return forward(request, `courses/${encodeURIComponent(courseId)}/topics`, "GET");
  }
  if (action === "interviewCatalog") return forward(request, "interview/catalog", "GET");
  if (action === "scenarios") return forward(request, "scenarios", "GET");
  if (action === "attemptDetail") return forward(request, `attempts/${encodeURIComponent(query.get("attemptId") ?? "")}`, "GET");
  if (action === "interviewQuestions") {
    const params = new URLSearchParams({ category: query.get("category") ?? "", difficulty: query.get("difficulty") ?? "" });
    return forward(request, `interview/questions?${params}`, "GET");
  }
  if (action !== "questions") return Response.json({ detail: "Unsupported practice action." }, { status: 400 });
  const params = new URLSearchParams();
  for (const name of ["courseId", "topicId", "syllabusVersion", "difficulty"]) {
    const value = query.get(name);
    if (value) params.set(name, value);
  }
  return forward(request, `questions?${params.toString()}`, "GET");
}

export async function POST(request: Request) {
  let body: { action?: string; mode?: "concept" | "interview" | "scenario"; courseId?: string; topicId?: string; syllabusVersion?: number; difficulty?: string; questionCount?: number; questionFormat?: "mixed" | "mcq" | "short_answer"; targetRole?: string; setId?: string; sessionId?: string; answers?: Record<string, number | string>; category?: string; questionId?: string; answer?: number | string; revisionQuestionIds?: string[]; scenarioId?: string; response?: string; checklistIds?: string[]; forRevision?: boolean };
  try { body = await request.json(); }
  catch { return Response.json({ detail: "Invalid JSON request." }, { status: 400 }); }
  if (body.action === "submit") {
    const payload = { courseId: body.courseId, topicId: body.topicId, syllabusVersion: body.syllabusVersion, difficulty: body.difficulty, answers: body.answers };
    return forward(request, "submit", "POST", payload);
  }
  if (body.action === "generate") {
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "action"));
    return forward(request, "generate", "POST", payload, 130_000);
  }
  if (body.action === "generatedSubmit") {
    const payload = { setId: body.setId, sessionId: body.sessionId, answers: body.answers };
    return forward(request, "generated-submit", "POST", payload);
  }
  if (body.action === "interviewCheck") {
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "action"));
    return forward(request, "interview/check", "POST", payload);
  }
  if (body.action === "interviewSubmit") {
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "action"));
    return forward(request, "interview/submit", "POST", payload);
  }
  if (body.action === "scenarioSubmit") {
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "action"));
    return forward(request, "scenarios/submit", "POST", payload);
  }
  return Response.json({ detail: "Unsupported practice action." }, { status: 400 });
}
