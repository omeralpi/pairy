// Protected trades: the public addresses and fixed values every escrow is
// checked against, on the server and in the browser. Committed, not env, so
// every change is reviewable in git history.

/**
 * The escrow's platform role, at a 0 fee. Its own key was switched off in the
 * same transaction that added its USDC trustline, so nothing can sign for it
 * (scripts/ops/setup-platform.ts; created 2026-11-23 in tx c8dcfad4).
 */
export const PLATFORM_ACCOUNT = "GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW";
