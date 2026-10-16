export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }

  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

  try {
    const response = await fetch(`${backend}/api/progress/summary`, {
      method: "GET",
      headers: { Authorization: authorization },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status });
  } catch (error) {
    return Response.json({
      detail: error instanceof Error && error.name === "TimeoutError"
        ? "The progress service timed out. Please retry."
        : "The progress service is unavailable right now. Please retry.",
    }, { status: error instanceof Error && error.name === "TimeoutError" ? 504 : 503 });
  }
}
