// Server errors as sentences a trader can act on. The state machine's own
// messages ("Cannot agree a agreed trade: ...") are written for logs, and a
// lapsed session arrives as the bare code "UNAUTHORIZED".

type ApiError = { message: string; data?: { code?: string } | null };

export const SESSION_ENDED = "Your session ended. Sign in again.";

export function isUnauthorized(e: unknown): boolean {
  return (e as ApiError | null)?.data?.code === "UNAUTHORIZED";
}

const TRANSITION = /^Cannot (\w+) a (\w+) trade: (.*)$/;

const ENDED = ["claimed", "reclaimed", "released", "resolved_buyer", "resolved_seller"];

function transitionMessage(event: string, from: string, reason: string): string {
  if (reason.startsWith("the party that opened")) return "You opened this trade, so your peer is the one who agrees to it.";
  // The state machine's mode and dispute reasons (lib/trade/state-machine.ts check()).
  if (reason === "only a protected trade has an escrow") return "This isn't a protected trade.";
  if (reason === "a protected trade settles through its escrow") return "This is a protected trade: it settles through its escrow, not a lock.";
  if (reason === "a disputed escrow is settled by the arbiter") return "A dispute is open on this escrow, so only the arbiter can settle it.";
  if (reason === "the escrow is already disputed") return "A dispute is already open on this escrow.";
  if (reason === "only a disputed escrow is resolved by the arbiter") return "This escrow has no open dispute.";
  if (from === "cancelled") return event === "cancel" ? "This trade was already cancelled." : "This trade was cancelled.";
  if (ENDED.includes(from)) return "This trade has already ended.";
  if (event === "agree") return "This trade was already agreed.";
  if (event === "cancel" && from === "locked") {
    return "This trade is already locked, so it can't be cancelled. The buyer can claim it, or the seller takes it back after the window.";
  }
  if (event === "cancel" && from === "funded") {
    return "This trade is funded, so it can't be cancelled. The seller releases the escrow, or a dispute goes to the arbiter.";
  }
  if (event === "lock" && from === "locked") return "This trade is already locked.";
  if (event === "escrowCreate" && (from === "escrow_created" || from === "funded")) return "The escrow was already created.";
  if (event === "fund" && from === "funded") return "The escrow is already funded.";
  return "This trade changed in the meantime. The page now shows where it stands.";
}

export function friendlyError(e: ApiError): string {
  if (isUnauthorized(e)) return SESSION_ENDED;
  const m = e.message.match(TRANSITION);
  return m ? transitionMessage(m[1], m[2], m[3]) : e.message;
}
