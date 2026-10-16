// TradeStateMachine: the off-chain record of a trade's progress.
//
//   listed ──agree──► agreed ──lock──► locked ──claim───► claimed
//     │                 │                 └────reclaim──► reclaimed
//     └──cancel─────────┴──cancel──► cancelled
//
// `disputed` is a flag, not a state: either party can raise it on a live
// trade and the machine records it without acting on it. The Phase 2 arbiter
// plugs into that flag. Nothing here evaluates claim predicates. Whether a
// claim or reclaim is allowed is decided on-chain; this machine only records
// what the chain already accepted.

export const TRADE_STATES = [
  "listed",
  "agreed",
  "locked",
  "claimed",
  "reclaimed",
  "cancelled",
] as const;
export type TradeState = (typeof TRADE_STATES)[number];

export const TERMINAL_STATES: readonly TradeState[] = [
  "claimed",
  "reclaimed",
  "cancelled",
];

export type TradeRole = "seller" | "buyer";

export type TradeEvent =
  | { type: "agree"; by: TradeRole }
  | { type: "lock"; by: TradeRole; balanceId: string; txHash: string }
  | { type: "claim"; by: TradeRole; txHash: string }
  | { type: "reclaim"; by: TradeRole; txHash: string }
  | { type: "cancel"; by: TradeRole }
  | { type: "flagDispute"; by: TradeRole };

export type TradeSnapshot = {
  state: TradeState;
  disputed: boolean;
  /** The party that opened the trade; the other one agrees to it. */
  openedBy: TradeRole;
  balanceId: string | null;
  lockTx: string | null;
  claimTx: string | null;
  reclaimTx: string | null;
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

  static open(openedBy: TradeRole): TradeStateMachine {
    return new TradeStateMachine({
      state: "listed",
      disputed: false,
      openedBy,
      balanceId: null,
      lockTx: null,
      claimTx: null,
      reclaimTx: null,
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
    const { state, openedBy } = this.snapshot;
    switch (event.type) {
      case "agree":
        if (state !== "listed") return "only a listed trade can be agreed";
        if (event.by === openedBy) return "the party that opened the trade cannot agree to it";
        return null;
      case "lock":
        if (state !== "agreed") return "only an agreed trade can be locked";
        if (event.by !== "seller") return "only the seller locks";
        return null;
      case "claim":
        if (state !== "locked") return "only a locked trade can be claimed";
        if (event.by !== "buyer") return "only the buyer claims";
        return null;
      case "reclaim":
        if (state !== "locked") return "only a locked trade can be reclaimed";
        if (event.by !== "seller") return "only the seller reclaims";
        return null;
      case "cancel":
        if (state !== "listed" && state !== "agreed") {
          return "once locked, the only ways out are claim and reclaim";
        }
        return null;
      case "flagDispute":
        if (isTerminal(state)) return "the trade is already settled";
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
        return new TradeStateMachine({ ...s, state: "cancelled" });
      case "flagDispute":
        return new TradeStateMachine({ ...s, disputed: true });
    }
  }
}
