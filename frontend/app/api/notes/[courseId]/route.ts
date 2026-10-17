import { backendFetch } from "@/lib/backend-fetch";

export const maxDuration = 120;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ detail: "Please sign in to continue." }, { status: 401 });
  }
  const { courseId } = await params;
  const backend = (process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const response = await backendFetch(`${backend}/api/notes/${encodeURIComponent(courseId)}`, {
      method: "DELETE", headers: { Authorization: authorization }, cache: "no-store", signal: AbortSignal.timeout(115_000),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ detail: "Notes storage is unavailable. The course was not deleted." }, { status: 503 });
  }
}
