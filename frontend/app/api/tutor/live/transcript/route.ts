export const maxDuration = 30;

async function forward(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "Invalid JSON request." }, { status: 400 });
  }
  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const response = await fetch(`${backend}/api/tutor/live/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch (error) {
    return Response.json({ detail: error instanceof Error && error.name === "TimeoutError"
      ? "Saving the live tutor transcript timed out. Reload saved progress before retrying."
      : "The tutor backend is unavailable. Your saved progress is unchanged." },
    { status: error instanceof Error && error.name === "TimeoutError" ? 504 : 503 });
  }
}

export function POST(request: Request) { return forward(request); }
