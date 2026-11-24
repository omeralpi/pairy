import type { BuyerClaim } from "@/components/trade/guards";
import type { RouterOutputs } from "@/lib/api";
import { netAfterFee } from "@/lib/escrow/fee";
import { answerDeadline, promiseDeadline } from "@/lib/escrow/rule";
import { fromStroops, toStroops } from "@/lib/trade/amount";
import type { TradeMode, TradeRole, TradeState } from "@/lib/trade/state-machine";

export type TradeView = RouterOutputs["trade"]["byId"];

/** Group headers on the trades list (set as eyebrows). */
export const STATE_LABEL: Record<TradeState, string> = {
  listed: "Waiting to agree",
  agreed: "Agreed",
  locked: "Locked",
  claimed: "Settled",
  reclaimed: "Taken back",
  cancelled: "Cancelled",
  escrow_created: "In escrow",
  funded: "Funded",
  released: "Settled",
  resolved_buyer: "Settled by the arbiter",
  resolved_seller: "Settled by the arbiter",
};

export const roleName = (r: TradeRole) => (r === "seller" ? "Seller" : "Buyer");

const other = (r: TradeRole): TradeRole => (r === "seller" ? "buyer" : "seller");

/** What the buyer receives from an escrow holding `amount`: 0.3% goes to Trustless Work. */
const netOf = (amount: string) => fromStroops(netAfterFee(toStroops(amount)));

/**
 * The columns a sentence about a trade's state is written from; `mine` and
 * `byId` both carry them. Without `mode` the trade is read as claimable.
 */
type TradeStatus = {
  state: TradeState;
  role: TradeRole;
  openedBy: TradeRole;
  asset: string;
  amount?: string;
  mode?: TradeMode;
  disputed?: boolean;
  lockTx?: string | null;
  createTx?: string | null;
  fundTx?: string | null;
};

/**
 * Where a trade stands, as one plain sentence from the viewer's side.
 * `claim`, for a locked trade: whether the buyer can claim right now. Only
 * "open" tells the buyer to hand over the cash; "unknown" while that is
 * being read, "unchecked" where it is not read at all (the trades list),
 * "blocked" with what stands in the way.
 */
export function statusSentence(t: TradeStatus, claim: BuyerClaim | { state: "unchecked" } = { state: "open" }): string {
  if (t.mode === "protected") return protectedSentence(t);
  switch (t.state) {
    case "listed":
      // The side that did not open the trade is the one that agrees to it.
      return t.role === t.openedBy
        ? `Waiting for the ${t.role === "seller" ? "buyer" : "seller"} to agree.`
        : "Waiting for you to agree.";
    case "agreed":
      return "Agreed. Lock when you're both at the meeting point.";
    case "locked":
      if (claim.state === "unknown") return "Locked. Checking the claim window on Stellar testnet…";
      if (claim.state === "closed") {
        return t.role === "buyer"
          ? "Your claim window has closed. Don't hand over cash."
          : `The buyer's claim window has closed. You can take the ${t.asset} back.`;
      }
      if (t.role === "buyer" && claim.state === "blocked") return `Don't hand over cash yet. ${claim.reason}`;
      if (t.role === "buyer" && claim.state === "unchecked") {
        return "It's locked for you. Open the trade and check you can claim before you hand over cash.";
      }
      return t.role === "buyer"
        ? "It's locked for you. Hand over the cash, then claim before you part."
        : "Locked. The buyer can claim it at any moment, cash or not.";
    case "claimed":
      return t.role === "buyer"
        ? `Settled. The ${t.asset} is in your wallet.`
        : `Settled. The ${t.asset} is in the buyer's wallet.`;
    case "reclaimed":
      return t.role === "seller"
        ? `Taken back. The ${t.asset} is back in your wallet.`
        : `Taken back. The ${t.asset} went back to the seller.`;
    case "cancelled":
      // Only a testnet reset cancels a trade that was locked.
      return t.lockTx
        ? "Closed: Stellar testnet was reset, so this lock no longer exists."
        : "Cancelled. Nothing was locked.";
    // A claimable trade never reaches an escrow state.
    case "escrow_created":
    case "funded":
    case "released":
    case "resolved_buyer":
    case "resolved_seller":
      return `${STATE_LABEL[t.state]}.`;
  }
}

/**
 * The protected trade's headline. There is no lock and no claim: the USDC
 * sits in the escrow until the seller releases it or the arbiter decides.
 */
function protectedSentence(t: TradeStatus): string {
  switch (t.state) {
    case "listed":
      return t.role === t.openedBy
        ? `Protected trade. Waiting for the ${other(t.role)} to accept the terms.`
        : "Protected trade. Waiting for you to accept the terms.";
    case "agreed":
      return t.role === "seller"
        ? "Agreed. Create the escrow when you're ready."
        : "Agreed. Waiting for the seller to create the escrow.";
    case "escrow_created":
      return t.role === "seller"
        ? "The escrow exists. Check its terms, then fund it."
        : "The escrow exists. Waiting for the seller to fund it.";
    case "funded":
      if (t.disputed) return "Dispute open. Only the arbiter can settle this escrow now.";
      return t.role === "seller"
        ? "Funded. Release only when you hold the cash."
        : "Funded. Hand over the cash only when the release shows here.";
    case "released":
      return t.role === "buyer"
        ? `Settled. You received ${netOf(t.amount ?? "0")} USDC.`
        : `Settled. The buyer received ${netOf(t.amount ?? "0")} USDC.`;
    case "resolved_buyer":
    case "resolved_seller": {
      const outcome: TradeRole = t.state === "resolved_buyer" ? "buyer" : "seller";
      return `Settled by the arbiter: all to ${outcome === t.role ? "you" : `the ${outcome}`}, less 0.3%.`;
    }
    case "cancelled":
      // Only a testnet reset cancels a funded protected trade.
      if (t.fundTx) return "Closed: Stellar testnet was reset, so this escrow no longer exists.";
      return t.createTx ? "Cancelled. The escrow was never funded." : "Cancelled. No escrow was created.";
    // A protected trade never holds a lock.
    case "locked":
    case "claimed":
    case "reclaimed":
      return `${STATE_LABEL[t.state]}.`;
  }
}

/**
 * The trades list's line under a disputed protected trade: the viewer's own
 * 24 h answer deadline (from when Pairy recorded the dispute, DECISIONS 1)
 * until they answer or it passes, then the arbiter's 72 h promise. Null
 * when there is no open dispute on a funded escrow.
 */
export function disputeBadge(
  t: {
    state: TradeState;
    role: TradeRole;
    mode: TradeMode;
    disputed: boolean;
    disputeRecordedAt: Date | null;
    disputedAt: Date | null;
    answers?: Partial<Record<TradeRole, unknown>> | null;
  },
  now: number = Date.now(),
): string | null {
  if (t.mode !== "protected" || t.state !== "funded" || !t.disputed || !t.disputeRecordedAt) return null;
  const deadline = answerDeadline({ disputeRecordedAt: t.disputeRecordedAt });
  if (t.answers?.[t.role] == null && now < deadline.getTime()) return `Dispute open: answer by ${shortWhen(deadline)}`;
  const promise = promiseDeadline({ disputedAt: t.disputedAt ?? t.disputeRecordedAt });
  return `Dispute open: the arbiter applies the rule by ${shortWhen(promise)}`;
}

/**
 * The trades list has no server time, only the device clock. It reports the
 * window closed this much early, so a device clock up to 10 minutes slow
 * still never shows "hand over the cash" after the real deadline.
 */
export const LIST_CLOCK_MARGIN_MS = 10 * 60 * 1000;

/**
 * Whether a locked trade's claim window is over, for the trades list.
 * `lockedAt` is the lock's ledger close time (the record time on old rows).
 */
export function lockWindowClosed(
  t: { state: TradeState; lockedAt: Date | null; windowSeconds: number },
  now: number = Date.now(),
): boolean {
  if (t.state !== "locked" || t.lockedAt === null) return false;
  return now >= t.lockedAt.getTime() + t.windowSeconds * 1000 - LIST_CLOCK_MARGIN_MS;
}

/** 259200 → "72 hours", 60 → "1 minute". */
export function windowLabel(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** 259200 → "72 h", 60 → "1 min". */
export function windowShort(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Milliseconds → "71:59:54". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

/** "16 Oct, 14:05" */
export const shortWhen = (d: Date | number) =>
  new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
