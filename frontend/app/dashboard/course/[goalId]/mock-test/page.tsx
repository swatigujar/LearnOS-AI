import { redirect } from "next/navigation";

export default async function LegacyMockTestRoute({
  params,
}: {
  params: Promise<{ goalId: string }>;
}) {
  const { goalId } = await params;
  redirect(`/dashboard/courses/${encodeURIComponent(goalId)}/mock-test`);
}
