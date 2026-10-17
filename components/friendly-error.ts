// Server errors as sentences a trader can act on. The state machine's own
// messages ("Cannot agree a agreed trade: ...") are written for logs, and a
// lapsed session arrives as the bare code "UNAUTHORIZED".

type ApiError = { message: string; data?: { code?: string } | null };

export const SESSION_ENDED = "Your session ended. Sign in again.";

export function isUnauthorized(e: unknown): boolean {
  return (e as ApiError | null)?.data?.code === "UNAUTHORIZED";
}

const TRANSITION = /^Cannot (\w+) a (\w+) trade: (.*)$/;

function transitionMessage(event: string, from: string, reason: string): string {
  if (reason.startsWith("the party that opened")) return "You opened this trade, so your peer is the one who agrees to it.";
  if (from === "cancelled") return event === "cancel" ? "This trade was already cancelled." : "This trade was cancelled.";
  if (from === "claimed" || from === "reclaimed") return "This trade has already ended.";
  if (event === "agree") return "This trade was already agreed.";
  if (event === "cancel" && from === "locked") {
    return "This trade is already locked, so it can't be cancelled. The buyer can claim it, or the seller takes it back after the window.";
  }
  if (event === "lock" && from === "locked") return "This trade is already locked.";
  return "This trade changed in the meantime. The page now shows where it stands.";
}

export function friendlyError(e: ApiError): string {
  if (isUnauthorized(e)) return SESSION_ENDED;
  const m = e.message.match(TRANSITION);
  return m ? transitionMessage(m[1], m[2], m[3]) : e.message;
}
