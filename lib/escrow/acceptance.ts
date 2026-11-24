// The acceptance screen both traders accept before a protected trade's escrow
// is created: SOW D2's text, word for word, as docs/arbitration.md publishes
// it. acceptance.test.ts holds the two together byte for byte.

import { hash } from "@stellar/stellar-sdk";

export const ACCEPTANCE_TITLE = "Protected trade: read before you accept.";

export const ACCEPTANCE_ITEMS = [
  "The USDC goes into a Trustless Work escrow instead of the usual lock. The buyer is paid only when the seller releases it, or when the arbiter settles a dispute.",
  "The arbiter is the Pairy team, Ömer Alpi and Ensar Mert Günay, and both must sign. Its account and signer list are linked below. Pairy also runs this app, and the escrow cannot tell these apart.",
  "If either of you opens a dispute, the arbiter can send the whole amount anywhere. Pairy's rules allow only all to the buyer or all back to the seller. The arbiter cannot open a dispute and cannot touch this trade's USDC if nobody does.",
  "The arbiter does not judge and cannot see the cash. Each of you answers \"Was the cash handed over in full?\" within 24 hours. If the seller says yes, the buyer is paid. If the seller does not answer and the buyer says yes, the buyer is paid. In every other case, including when you disagree, the seller gets the USDC back. Buyer: let go of the cash only when the release shows on your screen. Seller: after you fund, check the trade room daily; a dispute you do not answer within 24 hours pays the buyer if the buyer says yes.",
  "The escrow has no deadline. If the trade stalls, the seller gets the money back only through a dispute, and only when the arbiter acts (promised within 72 hours). If either arbiter key is lost, a disputed trade cannot be settled and its USDC stays locked.",
  "Trustless Work keeps 0.3% of every exit, refunds included: of 100 USDC, 99.7 is paid out.",
  "Test money on Stellar testnet only.",
] as const;

/**
 * sha256 (hex) of the title and the items, one per line: the version a trader
 * accepts and the trade stores, so a later edit of the text is a new version.
 */
export const ACCEPTANCE_VERSION = Array.from(hash([ACCEPTANCE_TITLE, ...ACCEPTANCE_ITEMS].join("\n")), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
