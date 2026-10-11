export const maxDuration = 150;

async function forward(request: Request, method: "GET" | "POST") {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }
  let body: unknown;
  if (method === "POST") {
    try {
      body = await request.json();
    } catch {
      return Response.json({ detail: "Invalid JSON request." }, { status: 400 });
    }
  }
  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const courseId = new URL(request.url).searchParams.get("courseId") ?? "";
  const path = method === "GET" ? `/state?courseId=${encodeURIComponent(courseId)}` : "/action";
  try {
    const response = await fetch(`${backend}/api/tutor${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: authorization },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(150_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch (error) {
    return Response.json({ detail: error instanceof Error && error.name === "TimeoutError"
      ? "The tutor request timed out. Reload saved progress before retrying."
      : "The tutor backend is unavailable. Your saved progress is unchanged." },
    { status: error instanceof Error && error.name === "TimeoutError" ? 504 : 503 });
  }
}

export function GET(request: Request) { return forward(request, "GET"); }
export function POST(request: Request) { return forward(request, "POST"); }