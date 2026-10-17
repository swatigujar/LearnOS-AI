export type CodeLabAction = "generate" | "explain" | "debug" | "tests";

export function buildCodeLabPrompt(action: CodeLabAction, lessonTitle: string, code = "") {
  const lesson = lessonTitle.trim();
  if (!lesson) throw new Error("Open a lesson before using Code Lab.");

  const source = code.trim();
  if (action !== "generate" && !source) throw new Error("Add Python code to continue.");
  if (source.length > 1400) throw new Error("Keep code input to 1,400 characters or fewer.");

  const scope = `Use the saved lesson “${lesson}” as context. Work in Python. Keep the response focused on this lesson. Do not claim the code was executed.`;
  const prompts: Record<CodeLabAction, string> = {
    generate: "Generate a small, readable Python example that demonstrates this lesson. Put the code in a code visual, then provide a concise explanation and sample input/output when useful.",
    explain: `Explain this Python code line by line in the context of this lesson. Include a concise example of its behavior.\n\nCode to explain:\n${source}`,
    debug: `Review this Python code for concrete errors. Explain the cause, put a corrected version in a code visual when you can support it from the lesson, and provide a sample input/output without claiming execution.\n\nCode to debug:\n${source}`,
    tests: `Create useful Python test cases for this code with expected results. Put runnable test examples in a code visual and explain what each case checks; do not claim the tests were run.\n\nCode to test:\n${source}`,
  };
  const prompt = `${prompts[action]}\n\n${scope}`;
  if (prompt.length > 2000) throw new Error("Shorten the code so the tutor request stays within 2,000 characters.");
  return prompt;
}
