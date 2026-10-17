import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET_USDC_ISSUER } from "@/lib/stellar/assets";
import { checkLock } from "@/lib/trade/preflight";

import { LIST_CLOCK_MARGIN_MS, lockWindowClosed, statusSentence } from "./format";
import {
  CLAIM_MARGIN_MS,
  buyerClaim,
  claimClosesAt,
  claimTrustlineProblem,
  lockGuard,
  serverClock,
  unrecordedLock,
  windowGates,
} from "./guards";

describe("lockGuard (Q-3)", () => {
  it("stops the send once the trade is no longer agreed", () => {
    expect(lockGuard("cancelled", [])).toMatch(/now cancelled, so the lock was not sent/);
    expect(lockGuard("locked", [])).toMatch(/now locked/);
  });

  it("stops a second lock when one is already on Stellar", () => {
    expect(lockGuard("agreed", [{ id: "noExistingLock", ok: false }])).toMatch(/already locked on Stellar/);
  });

  it("lets an agreed trade with no lock through", () => {
    expect(lockGuard("agreed", [{ id: "buyerAccount", ok: true }])).toBeNull();
  });
});

describe("claimTrustlineProblem (N-3)", () => {
  const check = (detail: string) => [{ id: "buyerTrustline" as const, ok: false, detail }];

  it("tells the buyer which trustline problem would fail the claim", () => {
    expect(claimTrustlineProblem(check("... (op_no_trust)."), "USDC")?.message).toMatch(/^Add USDC to your wallet first/);
    expect(claimTrustlineProblem(check("... (op_not_authorized)."), "USDC")).toMatchObject({
      code: "op_not_authorized",
      message: expect.stringMatching(/not authorized your USDC/),
    });
    expect(claimTrustlineProblem(check("... (op_line_full)."), "USDC")?.message).toMatch(/Raise the limit/);
  });

  it("reads the codes from the server's own preflight wording", () => {
    const buyer = (line?: object) =>
      ({
        balances: [
          { asset_type: "native", balance: "100", selling_liabilities: "0" },
          ...(line ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: TESTNET_USDC_ISSUER, ...line }] : []),
        ],
        subentry_count: line ? 1 : 0,
      }) as unknown as Horizon.AccountResponse;
    const problem = (b: Horizon.AccountResponse) =>
      claimTrustlineProblem(checkLock({ asset: "USDC", amount: "5", seller: null, buyer: b }).checks, "USDC")?.code;
    expect(problem(buyer())).toBe("op_no_trust");
    expect(problem(buyer({ balance: "0", limit: "1", is_authorized: true }))).toBe("op_line_full");
    expect(problem(buyer({ balance: "0", limit: "100", is_authorized: false }))).toBe("op_not_authorized");
    expect(problem(buyer({ balance: "0", limit: "100", is_authorized: true }))).toBeUndefined();
  });

  it("is null when the trustline is fine or not needed", () => {
    expect(claimTrustlineProblem([{ id: "buyerTrustline", ok: true, detail: null }], "USDC")).toBeNull();
    expect(claimTrustlineProblem([], "XLM")).toBeNull();
  });
});

describe("claim cutoff (Q-17, S-6, N-2)", () => {
  it("closes claims 10 s before the ledger deadline", () => {
    expect(CLAIM_MARGIN_MS).toBe(10_000);
    expect(claimClosesAt(1_000_000)).toBe(990_000);
  });
});

describe("statusSentence for a trade closed by a testnet reset", () => {
  it("does not say nothing was locked when the reset wiped a lock", () => {
    const t = { state: "cancelled" as const, openedBy: "buyer" as const, asset: "XLM", role: "buyer" as const };
    expect(statusSentence({ ...t, lockTx: null })).toBe("Cancelled. Nothing was locked.");
    expect(statusSentence({ ...t, lockTx: "a".repeat(64) })).toBe(
      "Closed: Stellar testnet was reset, so this lock no longer exists.",
    );
  });
});

describe("statusSentence after the window (Q-4)", () => {
  const locked = { state: "locked" as const, openedBy: "buyer" as const, asset: "USDC" };

  it("stops telling the buyer to hand over cash once the window has closed", () => {
    expect(statusSentence({ ...locked, role: "buyer" })).toMatch(/Hand over the cash/);
    expect(statusSentence({ ...locked, role: "buyer" }, { state: "closed" })).toBe("Your claim window has closed. Don't hand over cash.");
    expect(statusSentence({ ...locked, role: "seller" }, { state: "closed" })).toMatch(/You can take the USDC back/);
  });

  it("does not tell the buyer to hand over cash while the window is still being read (F5)", () => {
    expect(statusSentence({ ...locked, role: "buyer" }, { state: "unknown" })).toBe("Locked. Checking the claim window on Stellar testnet…");
    expect(statusSentence({ ...locked, role: "buyer" }, { state: "unknown" })).not.toMatch(/Hand over/);
  });
});

describe("device clock skew (Q-17)", () => {
  const T = 1_800_000_000_000; // the deadline: buyer before, seller from
  const FAST = 2 * 60_000; // device clock 2 minutes ahead of the server
  // What claimWindow says at server time `at`, received on a device FAST ahead.
  const answer = (at: number) => ({
    w: { buyerCanClaim: at < T, buyerClaimUntil: T, sellerCanReclaim: at >= T, sellerReclaimFrom: T, serverNow: at },
    receivedAt: at + FAST,
  });

  it("a fast device clock does not open reclaim early or close claim early", () => {
    const { w, receivedAt } = answer(T - 60_000); // a minute before the deadline
    const deviceNow = receivedAt + 5_000; // device already reads past T
    expect(deviceNow).toBeGreaterThan(T);
    const g = windowGates(w, serverClock(deviceNow, w.serverNow, receivedAt));
    expect(g.reclaimOpen).toBe(false);
    expect(g.claimOpen).toBe(true);
  });

  it("a slow device clock does not keep claim open past the cutoff", () => {
    const at = T - 30_000;
    const w = { buyerCanClaim: true, buyerClaimUntil: T, sellerCanReclaim: false, sellerReclaimFrom: T, serverNow: at };
    const receivedAt = at - FAST; // device 2 minutes behind
    const deviceNow = receivedAt + 25_000; // server time is now T - 5 s
    expect(deviceNow).toBeLessThan(claimClosesAt(T));
    const g = windowGates(w, serverClock(deviceNow, w.serverNow, receivedAt));
    expect(g.claimTooLate).toBe(true);
    expect(g.claimOpen).toBe(false);
  });
});

describe("trades list window (Q-4)", () => {
  const lockedAt = new Date(1_800_000_000_000);
  const t = { state: "locked" as const, lockedAt, windowSeconds: 259_200 };
  const deadline = lockedAt.getTime() + 259_200_000;

  it("closes a safety margin before the deadline, never after it", () => {
    expect(lockWindowClosed(t, deadline - LIST_CLOCK_MARGIN_MS - 1)).toBe(false);
    expect(lockWindowClosed(t, deadline - LIST_CLOCK_MARGIN_MS)).toBe(true);
    // A device clock 9 minutes slow, read just after the real deadline, already says closed.
    expect(lockWindowClosed(t, deadline + 1 - 9 * 60_000)).toBe(true);
  });

  it("never claims a closed window without a lock time or outside locked", () => {
    expect(lockWindowClosed({ ...t, lockedAt: null }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(lockWindowClosed({ ...t, state: "claimed" }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("unrecordedLock (round 2 F1)", () => {
  it("blocks Lock while a sent lock is unrecorded or its hash is stored here", () => {
    expect(unrecordedLock("ab".repeat(32), null)).toMatch(/Retry recording below; don't lock again/);
    expect(unrecordedLock(null, { kind: "lock" })).toMatch(/Don't lock again/);
  });

  it("lets Lock through otherwise", () => {
    expect(unrecordedLock(null, null)).toBeNull();
    expect(unrecordedLock(null, { kind: "claim" })).toBeNull();
  });
});

describe("buyerClaim: hand over cash only when a claim would work now (round 2 F3)", () => {
  const open = { window: "open" as const, tooLate: false, trust: null, wallet: null };
  const buyer = { state: "locked" as const, role: "buyer" as const, openedBy: "buyer" as const, asset: "USDC" };

  it("says hand over the cash only when nothing blocks the claim", () => {
    expect(buyerClaim(open)).toEqual({ state: "open" });
    expect(statusSentence(buyer, buyerClaim(open))).toMatch(/Hand over the cash/);
  });

  it("names what blocks the claim instead", () => {
    const trust = buyerClaim({ ...open, trust: "Add USDC to your wallet first." });
    expect(trust).toEqual({ state: "blocked", reason: "Add USDC to your wallet first." });
    expect(statusSentence(buyer, trust)).toBe("Don't hand over cash yet. Add USDC to your wallet first.");
    const wallet = buyerClaim({ ...open, wallet: "Connect your wallet to sign." });
    expect(statusSentence(buyer, wallet)).toMatch(/^Don't hand over cash yet\. Connect your wallet/);
  });

  it("treats the last 10 s as closed and an unread window as unknown", () => {
    expect(statusSentence(buyer, buyerClaim({ ...open, tooLate: true }))).toMatch(/closed. Don't hand over cash/);
    expect(statusSentence(buyer, buyerClaim({ ...open, window: "unknown" }))).not.toMatch(/Hand over/);
  });

  it("never tells the buyer to hand over cash on the trades list, which checks nothing", () => {
    expect(statusSentence(buyer, { state: "unchecked" })).not.toMatch(/Hand over the cash/);
    expect(statusSentence({ ...buyer, role: "seller" }, { state: "unchecked" })).toMatch(/The buyer can claim/);
  });
});


describe("statusSentence on a live lock: no protection the lock does not give (x12)", () => {
  const locked = { state: "locked" as const, openedBy: "buyer" as const, asset: "XLM" };

  it("tells the buyer to claim before parting, not some time later", () => {
    expect(statusSentence({ ...locked, role: "buyer" })).toBe("It's locked for you. Hand over the cash, then claim before you part.");
  });

  it("never tells the seller the claim waits for the cash", () => {
    for (const claim of [{ state: "open" as const }, { state: "unchecked" as const }]) {
      const s = statusSentence({ ...locked, role: "seller" }, claim);
      expect(s).toBe("Locked. The buyer can claim it at any moment, cash or not.");
      expect(s).not.toMatch(/once you have the cash/);
    }
  });
});
