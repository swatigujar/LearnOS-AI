export const maxDuration = 150;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "A Firebase authentication token is required." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "Invalid JSON request." }, { status: 400 });
  }
  try {
    const backendUrl = process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000";
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/api/syllabus/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(150_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return Response.json({ detail: "Syllabus generation timed out after 150 seconds. Please try again." }, { status: 504 });
    }
    return Response.json({ detail: "The syllabus backend is unavailable. Please retry." }, { status: 503 });
  }
}