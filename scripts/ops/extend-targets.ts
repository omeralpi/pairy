// What scripts/ops/extend-shared-escrow-code.ts keeps alive, and until when,
// besides the shared entries it finds itself. Kept apart so it can be tested
// (the script runs main() when it is imported).

import { Address, xdr } from "@stellar/stellar-sdk";

import { USDC_SAC } from "../../lib/escrow/config";

/** Day 30 (2026-12-23, O-46) plus 18 days' margin. */
export const TARGET = new Date("2027-01-10T00:00:00Z");

/**
 * Every escrow that EVIDENCE.md or docs/phase2-gates.md links on Trustless
 * Work's viewer, or names as a release, exit or dispute escrow (both files as
 * of phase2/wp43 e66ec9f). Each archives about 7 days after its deploy
 * (WP-14), long before day 30, and the day-30 checks open these links (O-46,
 * WP-47).
 */
export const EVIDENCE_ESCROWS = [
  // Release exit, Gate D2 (WP-11): EVIDENCE "The three protected-trade exits"; gates rows 5, S-18 and S-17.
  "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34",
  // Exit resolved to the buyer (WP-15): EVIDENCE "The three protected-trade exits" and "Answers and the 72-hour promise"; gates row 12.
  "CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2",
  // Exit resolved to the seller (WP-15): the same three places.
  "CBHHSX7ZAVL4IXJZBEYVZVDWLZNZYCN46Y54THMJDWIGUSMABFYCNHNR",
  // 2 USDC, disputed, kept for the owners' in-app signing (WP-26, O-36): EVIDENCE "Answers and the 72-hour promise".
  "CDPCKAUFKLQS6GITK2XCBHGGZM6EGZ7YQXI3JGDHXXFPLX5V6YDQE3UW",
  // T, 1 USDC, disputed (WP-37): EVIDENCE "Answers and the 72-hour promise".
  "CBR6V62IHRTKHE2ZMRBFXPAYJ47IYAEFZO2WS5SPGDRACXBIGNBFI5OC",
  // P, 1 USDC, disputed through Privy (WP-37): EVIDENCE "Answers and the 72-hour promise".
  "CDU6BFSMRYN3G6JFFZIAXUD7LNVQN46ACP6GQ5MALKNNHSMFTOMPSEXL",
  // Trade D, disputed (WP-38): EVIDENCE "Answers and the 72-hour promise" and "Local runs of the app"; gates row WP-38.
  "CD7VRCAJIOPGX7LIV5YRTH7VCWOZD4GEE7N3QHONU6HY23SYAZWXK6LU",
  // Trade A, released (WP-38): EVIDENCE "Local runs of the app"; gates row WP-38.
  "CCMAA6ZHRWCCYFFKB5WIYRKJXPB2ONI2F3AYYEOAIEUTFK7U2GQ5SJWH",
  // Trade P, released by a Privy seller (WP-38): the same two places.
  "CCKPK7HYKE6BHAS2HVFDJHF7ZTU27LO5F5REK7EBAYTDHS772CFW7DSM",
  // WP-03's escrow A: gates row S-13.
  "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN",
  // The Privy-signed fund and release: gates row S-06.
  "CBEHAVRIMTUBDHXXQQV56EDMOJSUL5PJAZL6S46RXRG4U35A33EIGMOG",
];

const persistent = (contractId: string, key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );

export const instanceOf = (contractId: string) => persistent(contractId, xdr.ScVal.scvLedgerKeyContractInstance());

/**
 * An escrow's own storage, the three entries lib/escrow/read.ts reads: its
 * instance, its ["Escrow"] entry and its balance entry in the USDC contract.
 * The USDC contract keeps a balance entry only about 30 days after its last
 * transfer, so the earliest of these lapse on day 30 itself.
 */
export const escrowEntries = (contractId: string) => [
  instanceOf(contractId),
  persistent(contractId, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Escrow")])),
  persistent(USDC_SAC, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(contractId).toScVal()])),
];
