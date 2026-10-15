export async function POST(
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
    const response = await fetch(`${backend}/api/notes/${encodeURIComponent(courseId)}/${encodeURIComponent(topicId)}/retry`, {
      method: "POST", headers: { Authorization: authorization }, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ detail: "The notes service is unavailable. Your course progress is unchanged." }, { status: 503 });
  }
}
