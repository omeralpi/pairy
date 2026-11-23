// Protected trades: the public addresses and fixed values every escrow is
// checked against, on the server and in the browser. Committed, not env, so
// every change is reviewable in git history.

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
