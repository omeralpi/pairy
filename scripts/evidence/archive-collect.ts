// What scripts/evidence/archive.ts keeps before the testnet reset, found in the
// evidence records and in the Markdown that links them. Kept apart so it can
// be tested on the record shapes (archive.ts runs main() when it is imported).

const TX_HASH = /^[0-9a-f]{64}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** Every string under one of `keys` that has `shape`, at any depth, once each. Nothing under a `skip` key is read. */
function valuesOf(json: unknown, keys: string[], shape: RegExp, skip: string[] = []): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (skip.includes(k)) continue;
      if (keys.includes(k) && typeof x === "string" && shape.test(x)) found.add(x);
      else walk(x);
    }
  };
  walk(json);
  return [...found];
}

/**
 * The transactions an out record names: every `hash` (txEvidence, the setup,
 * the steps, `landed`, both one-signature shapes) and every `txHash` (what
 * Trustless Work prepared, and the re-timed resolve). Any other 64-hex value
 * is not a transaction of the run: balance ids, wasm hashes, signatures, and
 * an attempt's twTxHash/rebuiltTxHash, which the step's own hash already
 * covers when that attempt landed. lockHash and reclaimHash repeat a
 * `hash` of abandon-72h.json and reclaim-72h.json.
 */
export function collectHashes(json: unknown): string[] {
  return valuesOf(json, ["hash", "txHash"], TX_HASH);
}

/** Each escrow an out record names. Trustless Work's deploy body has the token's contractId under `trustline`. */
export function collectEscrowIds(json: unknown): string[] {
  return valuesOf(json, ["contractId"], CONTRACT_ID, ["trustline"]);
}

/** The testnet records a Markdown file links: stellar.expert transactions and accounts, and escrows on Trustless Work's viewer. */
export function docLinks(markdown: string): { txs: string[]; escrows: string[]; accounts: string[] } {
  const all = (re: RegExp) => [...new Set(Array.from(markdown.matchAll(re), (m) => m[1]))];
  return {
    txs: all(/https:\/\/stellar\.expert\/explorer\/testnet\/tx\/([0-9a-f]{64})\b/g),
    escrows: all(/https:\/\/viewer\.trustlesswork\.com\/testnet\/v2\/(C[A-Z2-7]{55})\b/g),
    accounts: all(/https:\/\/stellar\.expert\/explorer\/testnet\/account\/(G[A-Z2-7]{55})\b/g),
  };
}
