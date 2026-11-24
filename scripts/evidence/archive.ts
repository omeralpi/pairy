// Keeps every pre-reset testnet record checkable after Stellar testnet's reset
// on 16 Dec 2026 at 17:00 UTC (FIXES F-01, X-05, X-06): the reset clears
// Horizon, Soroban RPC and stellar.expert, so every link to a transaction made
// before it stops resolving.
//
//   pnpm tsx scripts/evidence/archive.ts [<tx hash> | <escrow C…> | <account G…>]…
//
// Writes into scripts/evidence/archive/ (committed; public data only):
// - <hash>.json: Horizon's transaction record (envelope and result XDR,
//   successful, ledger, created_at, source account, fee charged) and its
//   operation records. For every hash in scripts/evidence/out/**/*.json
//   (collectHashes), every stellar.expert tx link in docs/phase2-gates.md and
//   EVIDENCE.md, and every hash on the command line (hosted-app and Privy txs
//   that are in neither).
// - escrow-<C…>.json: readEscrow's terms, status and storage TTL, from Soroban
//   RPC. For every escrow in the out records, every Trustless Work viewer link
//   in those two files, and every C… on the command line.
// - account-<G…>.json: Horizon's account record (signers, thresholds,
//   balances). For ARBITER_ACCOUNT, PLATFORM_ACCOUNT, every stellar.expert
//   account link in those two files, and every G… on the command line.
//
// A file already in archive/ is never overwritten, so a re-run only adds what
// is new; to take a new snapshot of an escrow or account, delete its file
// first. A hash Horizon does not know (Trustless Work's resolve before Pairy
// re-timed it, which was never sent) is listed, not written. It only reads:
// nothing is signed or sent, and no key is read. Exits 1 if any read failed;
// running it again retries only those.

import fs from "node:fs";
import path from "node:path";

import { StrKey } from "@stellar/stellar-sdk";

import { ARBITER_ACCOUNT, PLATFORM_ACCOUNT } from "../../lib/escrow/config";
import { EscrowNotFoundError, readEscrow } from "../../lib/escrow/read";
import { HORIZON_URL, SOROBAN_RPC_URL } from "../../lib/stellar/horizon";
import { collectEscrowIds, collectHashes, docLinks } from "./archive-collect";

const ROOT = path.join(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const ARCHIVE_DIR = path.join(__dirname, "archive");
const DOCS = ["docs/phase2-gates.md", "EVIDENCE.md"];

type Outcome = "written" | "kept" | "missing" | "failed";

/** null on 404. */
async function horizonGet(pathname: string): Promise<any> {
  const res = await fetch(`${HORIZON_URL}${pathname}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon ${pathname}: HTTP ${res.status}`);
  return res.json();
}

const fileOf = (name: string) => path.join(ARCHIVE_DIR, `${name}.json`);

function write(name: string, data: unknown) {
  const text = JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v), 2) + "\n";
  fs.writeFileSync(fileOf(name), text, { flag: "wx" }); // wx: never over an existing file
}

async function archiveTx(hash: string): Promise<Outcome> {
  const transaction = await horizonGet(`/transactions/${hash}`);
  if (!transaction) return "missing";
  const operations = await horizonGet(`/transactions/${hash}/operations?limit=200`);
  write(hash, {
    archivedAt: new Date().toISOString(),
    source: `${HORIZON_URL}/transactions/${hash}`,
    transaction,
    operations: operations._embedded.records,
  });
  return "written";
}

async function archiveEscrow(contractId: string): Promise<Outcome> {
  try {
    const { terms, status, ttl } = await readEscrow(contractId);
    write(`escrow-${contractId}`, { archivedAt: new Date().toISOString(), source: SOROBAN_RPC_URL, contractId, terms, status, ttl });
    return "written";
  } catch (e) {
    if (e instanceof EscrowNotFoundError) return "missing";
    throw e;
  }
}

async function archiveAccount(id: string): Promise<Outcome> {
  const account = await horizonGet(`/accounts/${id}`);
  if (!account) return "missing";
  write(`account-${id}`, { archivedAt: new Date().toISOString(), source: `${HORIZON_URL}/accounts/${id}`, account });
  return "written";
}

async function main() {
  const hashes = new Set<string>();
  const escrows = new Set<string>();
  const accounts = new Set<string>([ARBITER_ACCOUNT, PLATFORM_ACCOUNT]);

  for (const arg of process.argv.slice(2)) {
    if (/^[0-9a-f]{64}$/.test(arg)) hashes.add(arg);
    else if (StrKey.isValidContract(arg)) escrows.add(arg);
    else if (StrKey.isValidEd25519PublicKey(arg)) accounts.add(arg);
    else throw new Error(`${arg} is not a transaction hash, an escrow (C…) or an account (G…).`);
  }
  const outFiles = (fs.readdirSync(OUT_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith(".json")).sort();
  for (const f of outFiles) {
    const json: unknown = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    collectHashes(json).forEach((h) => hashes.add(h));
    collectEscrowIds(json).forEach((c) => escrows.add(c));
  }
  for (const doc of DOCS) {
    const links = docLinks(fs.readFileSync(path.join(ROOT, doc), "utf8"));
    links.txs.forEach((h) => hashes.add(h));
    links.escrows.forEach((c) => escrows.add(c));
    links.accounts.forEach((g) => accounts.add(g));
  }
  console.log(`${outFiles.length} out files and ${DOCS.join(", ")}: ${hashes.size} transactions, ${escrows.size} escrows, ${accounts.size} accounts`);

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const results: { name: string; outcome: Outcome; error?: string }[] = [];
  const run = async (name: string, archive: () => Promise<Outcome>) => {
    if (fs.existsSync(fileOf(name))) return results.push({ name, outcome: "kept" });
    try {
      results.push({ name, outcome: await archive() });
    } catch (e) {
      results.push({ name, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };
  // One request at a time: SDF's public Horizon limits requests per IP.
  for (const h of hashes) await run(h, () => archiveTx(h));
  for (const c of escrows) await run(`escrow-${c}`, () => archiveEscrow(c));
  for (const g of accounts) await run(`account-${g}`, () => archiveAccount(g));

  const of = (o: Outcome) => results.filter((r) => r.outcome === o);
  console.log(`written ${of("written").length}, already archived ${of("kept").length}, not on testnet ${of("missing").length}, failed ${of("failed").length}`);
  for (const r of of("missing")) console.log(`not on testnet: ${r.name}`);
  for (const r of of("failed")) console.log(`failed: ${r.name}: ${r.error}`);
  if (of("failed").length) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
