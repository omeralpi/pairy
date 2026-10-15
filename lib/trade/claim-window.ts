// Who can claim the locked balance right now, and when that changes, read
// from the claimable-balance record Horizon returns. Evaluation is done by
// stellar-resolve-claimant-predicates (SOW D1: "any UI countdown uses the
// existing stellar-resolve-claimant-predicates package"); Pairy writes no
// predicate logic of its own. The chain still has the final say: this is only
// for the countdown and for enabling buttons.

import type { Horizon } from "@stellar/stellar-sdk";
import {
  getPredicateInformation,
  predicateFromHorizonResponse,
} from "stellar-resolve-claimant-predicates";

export type ClaimWindow = {
  buyerCanClaim: boolean;
  /** Epoch ms after which the buyer can no longer claim. */
  buyerClaimUntil: number | null;
  sellerCanReclaim: boolean;
  /** Epoch ms from which the seller can reclaim. */
  sellerReclaimFrom: number | null;
};

export function claimWindow(
  claimants: Horizon.HorizonApi.Claimant[],
  buyer: string,
  seller: string,
  now: Date = new Date(),
): ClaimWindow {
  const info = (account: string) => {
    const c = claimants.find((x) => x.destination === account);
    return c ? getPredicateInformation(predicateFromHorizonResponse(c.predicate), now) : null;
  };
  const b = info(buyer);
  const s = info(seller);
  return {
    buyerCanClaim: b?.status === "claimable",
    buyerClaimUntil: b?.validTo ? b.validTo * 1000 : null,
    sellerCanReclaim: s?.status === "claimable",
    sellerReclaimFrom: s?.validFrom ? s.validFrom * 1000 : null,
  };
}
