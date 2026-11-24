// TradeStateMachine: the off-chain record of a trade's progress.
//
//   listed ──agree──► agreed ──lock──► locked ──claim───► claimed
//     │                 │                 └────reclaim──► reclaimed
//     └──cancel─────────┴──cancel──► cancelled
//        (or expire: no activity for a week, by the daily cleanup)
//   and, from any unfinished state, reset ──► cancelled when a testnet reset
//   wiped the accounts and the lock (scripts/ops/testnet-reset.ts)
//
// `disputed` is a flag, not a state: either party can raise it on a live
// trade and the machine records it without acting on it. Nothing here
// evaluates claim predicates. Whether a claim or reclaim is allowed is decided
// on-chain; this machine only records what the chain already accepted.
//
// Protected mode (a Trustless Work escrow with the 2-of-2 arbiter):
//
//   listed ──agree──► agreed ──escrowCreate──► escrow_created ──fund──► funded ──release──► released
//     │                 │                         │                       └──resolve──► resolved_buyer | resolved_seller
//     └──cancel─────────┴──cancel─────────────────┴──cancel──► cancelled
//
// Both sides accept the protected-trade terms (agree carries acceptedAt).
// Every escrow event is recorded only from the chain. Here `disputed` has a
// chain meaning: escrowDispute sets it from the dispute transaction, release
// needs it unset, resolve needs it set. A funded trade never cancels or
// expires. Each mode refuses the other mode's events.

import type { Outcome } from "@/lib/escrow/rule";

export const TRADE_STATES = [
  "listed",
  "agreed",
  "locked",
  "claimed",
  "reclaimed",
  "cancelled",
  "escrow_created",
  "funded",
  "released",
  "resolved_buyer",
  "resolved_seller",
] as const;
export type TradeState = (typeof TRADE_STATES)[number];

export const TERMINAL_STATES: readonly TradeState[] = [
  "claimed",
  "reclaimed",
  "cancelled",
  "released",
  "resolved_buyer",
  "resolved_seller",
];

export const TRADE_MODES = ["claimable", "protected"] as const;
export type TradeMode = (typeof TRADE_MODES)[number];

export type TradeRole = "seller" | "buyer";

export type TradeEvent =
  /** acceptedAt: when the agreeing side accepted the protected-trade terms; required in protected mode. */
  | { type: "agree"; by: TradeRole; acceptedAt?: Date }
  | {
      type: "lock";
      by: TradeRole;
      balanceId: string;
      txHash: string;
      /**
       * The lock was found on the ledger rather than reported in the normal
       * flow. The chain outranks the app, so it is recorded even if the app
       * had the trade as listed or cancelled.
       */
      reconcile?: boolean;
      /** When the lock landed on the ledger; starts the claim window. */
      lockedAt?: Date;
    }
  | { type: "claim"; by: TradeRole; txHash: string }
  | { type: "reclaim"; by: TradeRole; txHash: string }
  | { type: "cancel"; by: TradeRole }
  /** The daily cleanup ending a trade with no activity for a week (lib/trade/expire.ts). */
  | { type: "expire"; by: "system" }
  /** A testnet reset wiped the accounts and any lock (lib/trade/testnet-reset.ts). */
  | { type: "reset"; by: "system" }
  | { type: "flagDispute"; by: TradeRole }
  /** Protected mode, each read from the chain. contractId: the escrow the deploy created. */
  | { type: "escrowCreate"; by: TradeRole; contractId: string; txHash: string }
  /** fundedAt: the fund's ledger time. reconcile: found on the chain after the trade was cancelled. */
  | { type: "fund"; by: TradeRole; txHash: string; fundedAt: Date; reconcile?: boolean }
  | { type: "release"; by: TradeRole; txHash: string }
  /** by: the party that signed the dispute transaction. disputedAt: its ledger time. */
  | { type: "escrowDispute"; by: TradeRole; txHash: string; disputedAt: Date }
  /** outcome: who received the escrow. resolvedAt: the resolution's ledger time. */
  | { type: "resolve"; by: "arbiter"; outcome: Outcome; txHash: string; resolvedAt: Date };

const ESCROW_EVENTS: readonly TradeEvent["type"][] = ["escrowCreate", "fund", "release", "escrowDispute", "resolve"];
const CLAIMABLE_EVENTS: readonly TradeEvent["type"][] = ["lock", "claim", "reclaim", "flagDispute"];

export type TradeSnapshot = {
  state: TradeState;
  disputed: boolean;
  /** The party that opened the trade; the other one agrees to it. */
  openedBy: TradeRole;
  mode: TradeMode;
  balanceId: string | null;
  lockTx: string | null;
  claimTx: string | null;
  reclaimTx: string | null;
  /** Known from prepareCreate; the state, not this column, says whether the escrow exists. */
  escrowContractId: string | null;
  createTx: string | null;
  fundTx: string | null;
  releaseTx: string | null;
  disputeTx: string | null;
  resolveTx: string | null;
};

export class TradeTransitionError extends Error {
  constructor(
    readonly event: TradeEvent["type"],
    readonly from: TradeState,
    reason: string,
  ) {
    super(`Cannot ${event} a ${from} trade: ${reason}`);
    this.name = "TradeTransitionError";
  }
}

export function isTerminal(state: TradeState): boolean {
  return TERMINAL_STATES.includes(state);
}

export class TradeStateMachine {
  constructor(readonly snapshot: TradeSnapshot) {}

  static open(openedBy: TradeRole, mode: TradeMode = "claimable"): TradeStateMachine {
    return new TradeStateMachine({
      state: "listed",
      disputed: false,
      openedBy,
      mode,
      balanceId: null,
      lockTx: null,
      claimTx: null,
      reclaimTx: null,
      escrowContractId: null,
      createTx: null,
      fundTx: null,
      releaseTx: null,
      disputeTx: null,
      resolveTx: null,
    });
  }

  get state(): TradeState {
    return this.snapshot.state;
  }

  get isTerminal(): boolean {
    return isTerminal(this.snapshot.state);
  }

  /** null when the event is allowed, otherwise the reason it is not. */
  check(event: TradeEvent): string | null {
    const { state, openedBy, mode, disputed } = this.snapshot;
    if (mode === "claimable" && ESCROW_EVENTS.includes(event.type)) return "only a protected trade has an escrow";
    if (mode === "protected" && CLAIMABLE_EVENTS.includes(event.type)) return "a protected trade settles through its escrow";
    switch (event.type) {
      case "agree":
        if (state !== "listed") return "only a listed trade can be agreed";
        if (event.by === openedBy) return "the party that opened the trade cannot agree to it";
        if (mode === "protected" && !event.acceptedAt) return "a protected trade is agreed only by accepting its terms";
        return null;
      case "lock":
        if (event.by !== "seller") return "only the seller locks";
        if (state === "agreed") return null;
        if (event.reconcile && (state === "listed" || state === "cancelled")) return null;
        return "only an agreed trade can be locked";
      case "claim":
        if (state !== "locked") return "only a locked trade can be claimed";
        if (event.by !== "buyer") return "only the buyer claims";
        return null;
      case "reclaim":
        if (state !== "locked") return "only a locked trade can be reclaimed";
        if (event.by !== "seller") return "only the seller reclaims";
        return null;
      case "cancel":
      case "expire":
        if (state !== "listed" && state !== "agreed" && state !== "escrow_created") {
          return mode === "protected"
            ? "once funded, the only ways out are the release and the arbiter"
            : "once locked, the only ways out are claim and reclaim";
        }
        return null;
      case "reset":
      case "flagDispute":
        if (isTerminal(state)) return "the trade is already settled";
        return null;
      case "escrowCreate":
        if (event.by !== "seller") return "only the seller creates the escrow";
        if (state !== "agreed") return "only an agreed trade gets an escrow";
        if (this.snapshot.escrowContractId !== null && this.snapshot.escrowContractId !== event.contractId) {
          return "the escrow is not the one prepared for this trade";
        }
        return null;
      case "fund":
        if (event.by !== "seller") return "only the seller funds the escrow";
        if (state === "escrow_created") return null;
        // The escrow must have been recorded before the cancel: a fund never skips its creation.
        if (event.reconcile && state === "cancelled" && this.snapshot.createTx !== null) return null;
        return "only a created escrow can be funded";
      case "release":
        if (event.by !== "seller") return "only the seller releases";
        if (state !== "funded") return "only a funded escrow can be released";
        if (disputed) return "a disputed escrow is settled by the arbiter";
        return null;
      case "escrowDispute":
        if (state !== "funded") return "only a funded escrow can be disputed";
        if (disputed) return "the escrow is already disputed";
        return null;
      case "resolve":
        if (state !== "funded") return "only a funded escrow can be resolved";
        if (!disputed) return "only a disputed escrow is resolved by the arbiter";
        return null;
    }
  }

  can(event: TradeEvent): boolean {
    return this.check(event) === null;
  }

  /** Returns the next machine; never mutates this one. */
  apply(event: TradeEvent): TradeStateMachine {
    const reason = this.check(event);
    if (reason) throw new TradeTransitionError(event.type, this.state, reason);

    const s = this.snapshot;
    switch (event.type) {
      case "agree":
        return new TradeStateMachine({ ...s, state: "agreed" });
      case "lock":
        return new TradeStateMachine({
          ...s,
          state: "locked",
          balanceId: event.balanceId,
          lockTx: event.txHash,
        });
      case "claim":
        return new TradeStateMachine({ ...s, state: "claimed", claimTx: event.txHash });
      case "reclaim":
        return new TradeStateMachine({ ...s, state: "reclaimed", reclaimTx: event.txHash });
      case "cancel":
      case "expire":
      // The lock record stays: it is what the chain had before the reset.
      case "reset":
        return new TradeStateMachine({ ...s, state: "cancelled" });
      case "flagDispute":
        return new TradeStateMachine({ ...s, disputed: true });
      case "escrowCreate":
        return new TradeStateMachine({
          ...s,
          state: "escrow_created",
          escrowContractId: event.contractId,
          createTx: event.txHash,
        });
      case "fund":
        return new TradeStateMachine({ ...s, state: "funded", fundTx: event.txHash });
      case "release":
        return new TradeStateMachine({ ...s, state: "released", releaseTx: event.txHash });
      case "escrowDispute":
        return new TradeStateMachine({ ...s, disputed: true, disputeTx: event.txHash });
      case "resolve":
        return new TradeStateMachine({
          ...s,
          state: event.outcome === "buyer" ? "resolved_buyer" : "resolved_seller",
          resolveTx: event.txHash,
        });
    }
  }
}
