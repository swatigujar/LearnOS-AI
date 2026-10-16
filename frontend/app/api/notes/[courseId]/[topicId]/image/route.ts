export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string; topicId: string }> },
) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }
  const { courseId, topicId } = await params;
  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const response = await fetch(`${backend}/api/notes/${encodeURIComponent(courseId)}/${encodeURIComponent(topicId)}/image`, {
      headers: { Authorization: authorization }, cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      let detail = "The handwritten image is temporarily unavailable.";
      try { detail = (await response.json()).detail ?? detail; } catch { /* Keep the safe fallback. */ }
      return Response.json({ detail }, { status: response.status });
    }
    return new Response(response.body, {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" },
    });
  } catch {
    return Response.json({ detail: "The notes service is unavailable." }, { status: 503 });
  }
}
