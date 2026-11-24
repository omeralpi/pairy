// Protected trades: the public addresses and fixed values every escrow is
// checked against, on the server and in the browser. Committed, not env, so
// every change is reviewable in git history.

import type { WalletKind } from "@/lib/wallet/use-wallet";

/**
 * The wallet kinds that may open or accept a protected trade. All three: on
 * 2026-11-24 a Privy wallet signed a Trustless Work fund and release through
 * Pairy's raw-hash path and both landed (S-06, docs/phase2-gates.md), so the
 * SOW's fallback of hiding protected mode from Privy users is not needed.
 */
export const PROTECTED_WALLET_KINDS: readonly WalletKind[] = ["device", "freighter", "privy"];

/** Trustless Work's V2 API. Only server/tw/client.ts calls it (tests/ci/tw-endpoint-allowlist). */
export const TW_API_BASE = "https://beta.api.trustlesswork.com";

/**
 * The only dispute resolver every escrow names. Two signers at weight 1, its
 * own key at weight 0, thresholds 2/2/2 (scripts/ops/setup-arbiter.ts;
 * created 2026-11-23 in tx 3dfce09c). Its signers are not pinned here: the
 * list is meant to grow (3-of-5, then a council) without a code change.
 */
export const ARBITER_ACCOUNT = "GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH";

/**
 * The escrow's platform role, at a 0 fee. Its own key was switched off in the
 * same transaction that added its USDC trustline, so nothing can sign for it
 * (scripts/ops/setup-platform.ts; created 2026-11-23 in tx c8dcfad4).
 */
export const PLATFORM_ACCOUNT = "GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW";

/** Circle's testnet USDC as a contract: the token every escrow holds (config.test.ts re-derives it). */
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * Trustless Work's escrow factory, the escrow code it installs, and the
 * address its 0.3% fee goes to, as the Gate D2 release found them on testnet
 * (scripts/evidence/out/escrow-release-real.json; first seen in WP-03's
 * escrows). lib/escrow/xdr.ts refuses any deploy, release or resolution that
 * differs. After a testnet reset each may change and is re-pinned (WP-46);
 * while one is null, xdr.ts does not check it (FIXES F-02, F-10).
 */
export const TW_FACTORY_CONTRACT_ID: string | null = "CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL";
export const TW_ESCROW_WASM_HASH: string | null = "1231807d01111bee78a846ddacdd0a6cf88b762115e70f5bce16ffabd660e47f";
export const TW_FEE_ADDRESS: string | null = "GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF";

/**
 * Who the escrow names as service provider (DECISIONS 3). The seller alone
 * released with one signature and no milestone-status step on testnet (S-16),
 * so the buyer fallback is not used.
 */
export const SERVICE_PROVIDER_ROLE: "seller" | "buyer" = "seller";

/** Trustless Work's escrow viewer: anyone can check an escrow's roles there (S-13). */
export const TW_VIEWER_BASE = "https://viewer.trustlesswork.com";

export function twViewerUrl(contractId: string): string {
  return `${TW_VIEWER_BASE}/testnet/v2/${contractId}`;
}

/** The escrow's one milestone. */
export const MILESTONE_DESCRIPTION = "Cash handed over";

/** The reason every dispute carries. Public on chain, so it names nobody. */
export const DISPUTE_REASON = "Pairy protected trade: a trader opened a dispute.";

/** After a dispute is recorded, each trader has this long to answer (DECISIONS 1). */
export const ANSWER_WINDOW_MS = 24 * 3600_000;
/** The arbiter's published promise: a resolution within 72 h of the dispute. */
export const ARBITER_PROMISE_MS = 72 * 3600_000;
/** A funded trade with no release or dispute after this long gets a nudge. */
export const FUNDED_NUDGE_MS = 72 * 3600_000;
/** The longest dispute note, in characters. */
export const NOTE_MAX = 500;

/**
 * How long the arbiter's signers get to sign a resolution (O-17): before anyone
 * signs, Pairy re-times Trustless Work's resolve to Horizon time + this. One
 * committed value, never a request input; lib/escrow/xdr.ts holds it between
 * 10 minutes and 24 hours.
 */
export const RESOLVE_WINDOW_SECONDS = 3600;

/**
 * XLM, in stroops, the seller needs above the account's reserves for the
 * escrow's network fees. WP-03 measured about 0.015 XLM for fund and release
 * together; 2 XLM leaves room for fee surges.
 */
export const ESCROW_XLM_NEED = 20_000_000n;
