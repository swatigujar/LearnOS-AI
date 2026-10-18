const SEPARATOR = "\u00b7";

export function cleanScenarioHistoryText(value: unknown): string {
  if (typeof value !== "string") return "";

  return value
    .replace(/\u252c{2,}/g, ` ${SEPARATOR} `)
    .replace(/\u252c[\u2552\u2556]/g, ` ${SEPARATOR} `)
    .replace(/\u00c2\u00b7|\u00e2\u20ac\u00a2|\u0393\u00c7\u00f3/g, ` ${SEPARATOR} `)
    .replace(/\u252c/g, ` ${SEPARATOR} `)
    .replace(/\ufffd/g, "")
    .replace(/\s*\u00b7\s*/g, ` ${SEPARATOR} `)
    .replace(/\s+/g, " ")
    .trim();
}

export function scenarioHistoryTitle(courseValue: unknown, topicValue: unknown): string {
  const parts = [courseValue, topicValue]
    .map(cleanScenarioHistoryText)
    .flatMap((value) => value.split(SEPARATOR))
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = parts.filter((part, index) =>
    parts.findIndex((candidate) => candidate.toLocaleLowerCase() === part.toLocaleLowerCase()) === index,
  );
  return unique.join(` ${SEPARATOR} `) || "Practice session";
}
