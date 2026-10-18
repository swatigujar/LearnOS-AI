import type { TutorState } from "./tutor";

type Message = TutorState["conversation"]["messages"][number];

function messageText(message: Message) {
  const reply = message.reply;
  if (!reply) return message.text;
  if (reply.intent === "redirect") return reply.redirect_message.slice(0, 4000);
  return `${reply.concept_title}\n${reply.explanation}\nExample: ${reply.example}\nQuestion asked: ${reply.check_question}`.slice(0, 4000);
}

function sameMessage(left: Message, right: Message) {
  if (left.id && right.id) return left.id === right.id;
  return left.role === right.role && left.channel === right.channel && messageText(left) === messageText(right);
}

export function mergeTutorMessages(history: Message[], recent: Message[]): Message[] {
  if (!history.length) return recent;
  if (!recent.length) return history;
  const earlierRecent = recent.findIndex((message) => sameMessage(history[0], message));
  if (earlierRecent > 0) {
    return [...recent.slice(0, earlierRecent), ...mergeTutorMessages(history, recent.slice(earlierRecent))];
  }
  const recentStart = history.findIndex((message) => sameMessage(message, recent[0]));
  if (recentStart >= 0) {
    const overlap = Math.min(history.length - recentStart, recent.length);
    if (recent.slice(0, overlap).every((message, index) => sameMessage(history[recentStart + index], message))) {
      return [...history.slice(0, recentStart), ...recent, ...history.slice(recentStart + overlap)];
    }
  }
  for (let overlap = Math.min(history.length, recent.length); overlap > 0; overlap -= 1) {
    const offset = history.length - overlap;
    if (recent.slice(0, overlap).every((message, index) => sameMessage(history[offset + index], message))) {
      return [...history.slice(0, offset), ...recent];
    }
  }
  return [...history, ...recent];
}
