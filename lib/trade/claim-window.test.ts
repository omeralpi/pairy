import { Keypair, type Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { claimWindow } from "./claim-window";

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();

// Core turns BEFORE_RELATIVE_TIME into an absolute time when the balance is
// created, so this is the shape Horizon returns for a Pairy lock.
function claimants(deadline: Date): Horizon.HorizonApi.Claimant[] {
  const abs = { abs_before: deadline.toISOString().replace(".000Z", "Z"), abs_before_epoch: String(deadline.getTime() / 1000) };
  return [
    { destination: buyer, predicate: abs },
    { destination: seller, predicate: { not: abs } },
  ];
}

describe("claimWindow", () => {
  const deadline = new Date("2026-10-18T12:00:00Z");

  it("inside the window: buyer can claim, seller waits until the deadline", () => {
    const w = claimWindow(claimants(deadline), buyer, seller, new Date("2026-10-16T12:00:00Z"));
    expect(w).toEqual({
      buyerCanClaim: true,
      buyerClaimUntil: deadline.getTime(),
      sellerCanReclaim: false,
      sellerReclaimFrom: deadline.getTime(),
    });
  });

  it("after the window: only the seller can claim", () => {
    const w = claimWindow(claimants(deadline), buyer, seller, new Date("2026-10-18T12:00:01Z"));
    expect(w).toMatchObject({ buyerCanClaim: false, sellerCanReclaim: true });
  });
});
