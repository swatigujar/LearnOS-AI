export const maxDuration = 20;

async function forward(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/planner\/?/, "");
  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "DELETE") {
    try {
      body = await request.text();
      if (body) JSON.parse(body);
    } catch {
      return Response.json({ detail: "Invalid JSON request." }, { status: 400 });
    }
  }

  try {
    const response = await fetch(`${backend}/api/planner/${path}${url.search}`, {
      method: request.method,
      headers: {
        Authorization: authorization,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 204) return new Response(null, { status: 204 });
    const responseBody = await response.text();
    return new Response(responseBody, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json({
      detail: timedOut ? "The study planner timed out. Please retry." : "The study planner service is unavailable. Please retry.",
    }, { status: timedOut ? 504 : 503 });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;