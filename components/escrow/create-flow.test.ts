// The escrow creation's pure parts (WP-34). checkCreation runs on Trustless
// Work's real Gate D2 deploy, with Gate D2's trade, inside its 5-minute validity.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { EscrowNotFoundError } from "@/lib/escrow/read";

import { CREATE_STEPS, checkCreation, creationBlocked, escrowVisible, stepStatus } from "./create-flow";

const DEPLOY = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/gate-d2-deploy.json"), "utf8"));
const prepared = DEPLOY.response.body as { unsignedXdr: string; txHash: string; contractId: string };
const during = new Date(Date.parse(DEPLOY.at) + 1000);

// Gate D2's trade (scripts/evidence/out/escrow-release-real.json).
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const trade = { seller: SELLER, buyer: BUYER, amount: "5.0000000" };

describe("checkCreation: the browser's own check of the deploy (DECISIONS 7)", () => {
  it("passes Trustless Work's deploy for this trade and this one-time key, and says what it signs", () => {
    const c = checkCreation(prepared, trade, ADMIN, during);
    expect(c.problems).toEqual([]);
    expect(c.summary).toBe("Create this trade's escrow for 5 USDC");
    expect(Number(c.fee)).toBeGreaterThan(0);
    expect(Number(c.fee)).toBeLessThanOrEqual(2);
  });

  it("refuses it for another one-time key than the one this browser made", () => {
    expect(checkCreation(prepared, trade, Keypair.random().publicKey(), during).problems.length).toBeGreaterThan(0);
  });

  it("refuses it when the trade's own terms differ: amount, buyer or seller", () => {
    expect(checkCreation(prepared, { ...trade, amount: "5.0000001" }, ADMIN, during).problems.join(" ")).toMatch(/amount|5/);
    expect(checkCreation(prepared, { ...trade, buyer: Keypair.random().publicKey() }, ADMIN, during).problems.length).toBeGreaterThan(0);
    expect(checkCreation(prepared, { ...trade, seller: Keypair.random().publicKey() }, ADMIN, during).problems.length).toBeGreaterThan(0);
  });

  it("refuses an escrow address that is not the one the deploy creates, and a hash for another network", () => {
    const other = { ...prepared, contractId: "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN" };
    expect(checkCreation(other, trade, ADMIN, during).problems.join(" ")).toMatch(/is not the one this transaction creates/);
    expect(checkCreation({ ...prepared, txHash: "00".repeat(32) }, trade, ADMIN, during).problems.join(" ")).toMatch(/another network/);
  });

  it("refuses it once its 5 minutes are over", () => {
    expect(checkCreation(prepared, trade, ADMIN, new Date(Date.parse(DEPLOY.at) + 10 * 60_000)).problems.join(" ")).toMatch(/expired/);
  });

  it("refuses what is not a transaction at all, without throwing", () => {
    const c = checkCreation({ ...prepared, unsignedXdr: "not xdr" }, trade, ADMIN, during);
    expect(c.problems).toEqual([expect.stringMatching(/^It could not be read as a transaction/)]);
  });
});

describe("creationBlocked", () => {
  const ready = { loading: false, error: null, blockedReason: null };

  it("lets the seller create the escrow once every check passed", () => {
    expect(creationBlocked({ unreported: null, pending: null, preflight: ready })).toBeNull();
  });

  it("never lets a second creation start while one from this browser is on its way or unrecorded", () => {
    expect(creationBlocked({ unreported: "ab".repeat(32), pending: null, preflight: ready })).toMatch(/not recorded yet.*don't create another/);
    expect(creationBlocked({ unreported: null, pending: { kind: "create" }, preflight: ready })).toMatch(/already sent an escrow creation/);
    // Another step's hash is not a creation.
    expect(creationBlocked({ unreported: null, pending: { kind: "lock" }, preflight: ready })).toBeNull();
  });

  it("waits for the checks, and passes on why they fail", () => {
    expect(creationBlocked({ unreported: null, pending: null, preflight: { ...ready, loading: true } })).toBe("Checking both accounts on Stellar testnet…");
    expect(creationBlocked({ unreported: null, pending: null, preflight: { ...ready, error: "Could not reach Stellar testnet." } })).toBe(
      "Could not reach Stellar testnet.",
    );
    expect(creationBlocked({ unreported: null, pending: null, preflight: { ...ready, blockedReason: "The buyer needs a trustline." } })).toBe(
      "Sort out the item above, then create the escrow.",
    );
  });
});

describe("the steps on screen", () => {
  it("lists the creation in the order it happens: key, Friendbot, prepare, check, sign, send, record", () => {
    expect(CREATE_STEPS.map((s) => s.id)).toEqual(["key", "friendbot", "prepare", "check", "sign", "submit", "record"]);
  });

  it("marks the steps before the current one done, the current one running or failed, the rest not reached", () => {
    expect(CREATE_STEPS.map((s) => stepStatus(s.id, null, false))).toEqual(Array(7).fill("todo"));
    expect(CREATE_STEPS.map((s) => stepStatus(s.id, "prepare", false))).toEqual(["done", "done", "now", "todo", "todo", "todo", "todo"]);
    expect(stepStatus("friendbot", "friendbot", true)).toBe("failed");
    expect(stepStatus("key", "friendbot", true)).toBe("done");
  });
});

describe("escrowVisible", () => {
  it("waits until Soroban RPC shows the new escrow", async () => {
    const read = vi.fn().mockRejectedValueOnce(new EscrowNotFoundError("C")).mockRejectedValueOnce(new EscrowNotFoundError("C")).mockResolvedValue({});
    await escrowVisible("C", read, 5, 0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after its reads, and at once when Soroban RPC fails otherwise: the record then says why", async () => {
    const missing = vi.fn().mockRejectedValue(new EscrowNotFoundError("C"));
    await escrowVisible("C", missing, 4, 0);
    expect(missing).toHaveBeenCalledTimes(4);

    const down = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await escrowVisible("C", down, 4, 0);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
