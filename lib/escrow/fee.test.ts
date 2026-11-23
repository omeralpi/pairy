import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { toStroops } from "@/lib/trade/amount";

import { netAfterFee, twFee } from "./fee";

const FEE_ADDRESS = "GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF";

type Change = { from: string; to: string; amount: string };
/** The USDC transfers Horizon recorded for an exit (WP-03 and S-19 fixtures). */
function transfers(name: string): Change[] {
  const f = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
  const op = (f.onChain ?? f.distribution.onChain).horizonOperation[0];
  return op.assetBalanceChanges;
}

describe("twFee and netAfterFee", () => {
  // Every exit Trustless Work made on testnet: what the escrow held, and the two transfers that emptied it.
  it.each([
    ["approve-and-release-milestones", 100000000n],
    ["resolve-dispute", 100000000n],
    ["resolve-dispute-c", 123456789n],
    ["s19-resolve-buyer", 50000000n],
  ] as const)("match what %s paid on chain", (name, held) => {
    const out = transfers(name);
    expect(out).toHaveLength(2);
    const fee = out.find((t) => t.to === FEE_ADDRESS)!;
    const payee = out.find((t) => t.to !== FEE_ADDRESS)!;
    expect(twFee(held)).toBe(toStroops(fee.amount));
    expect(netAfterFee(held)).toBe(toStroops(payee.amount));
  });

  it("rounds the fee down to the stroop", () => {
    expect(twFee(123456789n)).toBe(370370n); // 370370.367
    expect(twFee(333n)).toBe(0n);
    expect(twFee(334n)).toBe(1n);
    expect(twFee(1n)).toBe(0n);
  });

  it("splits the escrow exactly: payee plus fee is the whole amount", () => {
    for (const amount of [1n, 333n, 334n, 99999999n, 123456789n, 9_223_372_036_854_775_807n]) {
      expect(netAfterFee(amount) + twFee(amount)).toBe(amount);
    }
  });
});
