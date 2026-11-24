// Fallback only (DECISIONS 16; D3 B4 step 4): issues the test euro token TEUR
// ("Test EUR") if no test EURC has reached the treasury by day 10 (Thu 3 Dec
// 2026). Two fresh Friendbot accounts: an issuer, and a distributor that
// becomes the TEUR treasury. One transaction: the distributor trusts
// TEUR:issuer, then the issuer pays it 1,000,000 TEUR. A plain classic asset:
// no contract, no auth_required, no home domain.
//
//   pnpm tsx scripts/ops/issue-test-euro.ts --dry-run
//     Builds the transaction against unfunded placeholder keys and prints its
//     operations. Nothing is funded, signed, submitted or written.
//
//   pnpm tsx scripts/ops/issue-test-euro.ts
//     The real run, once, on the day the fallback is decided. Pin the printed
//     issuer as ASSETS.TEUR (WP-23) and disclose it in EVIDENCE.md. Secrets go
//     to scripts/evidence/.state/teur-issuer.json and treasury-teur.json
//     (gitignored, 0600) and nowhere else. Refuses while either file exists.
//     After a testnet reset: run again, re-pin the issuer, EVIDENCE notes it.

import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { explorerAccountUrl, explorerTxUrl } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import {
  balanceStroops,
  freshAccount,
  loadAccount,
  signAndSubmit,
  sourceAccount,
  toStroops,
} from "../../tests/integration/testnet";
import { readState, writeState } from "../evidence/record";
import type { TreasuryState } from "./create-treasury";

const CODE = "TEUR";
const SUPPLY = "1000000.0000000";

export type TeurIssuerState = {
  account: string;
  secret: string;
  issueHash: string;
  createdAt: string;
};

/** The distributor is the source and trusts first; the issuer's payment follows. */
function buildIssueTx(distributor: Account, issuer: string) {
  const asset = new Asset(CODE, issuer);
  return new TransactionBuilder(distributor, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .addOperation(
      Operation.payment({
        source: issuer,
        destination: distributor.accountId(),
        asset,
        amount: SUPPLY,
      }),
    )
    .setTimeout(300)
    .build();
}

function describeOp(op: ReturnType<typeof buildIssueTx>["operations"][number], source: string) {
  switch (op.type) {
    case "changeTrust":
      return `changeTrust ${op.line instanceof Asset ? `${op.line.code}:${op.line.issuer}` : "pool share"} (source ${op.source ?? source})`;
    case "payment":
      return `payment ${op.amount} ${op.asset.code}:${op.asset.issuer} to ${op.destination} (source ${op.source ?? source})`;
    default:
      return op.type;
  }
}

function dryRun() {
  const issuer = Keypair.random().publicKey();
  const distributor = Keypair.random().publicKey();
  const tx = buildIssueTx(new Account(distributor, "0"), issuer);
  console.log(`dry run: ${tx.operations.length} operations, source ${distributor}, fee ${tx.fee} stroops`);
  for (const op of tx.operations) console.log(`  ${describeOp(op, distributor)}`);
  console.log("nothing funded, signed, submitted or written");
}

async function main() {
  if (process.argv.includes("--dry-run")) return dryRun();

  for (const name of ["teur-issuer", "treasury-teur"]) {
    if (readState(name)) {
      throw new Error(
        `scripts/evidence/.state/${name}.json already exists; refusing to issue a second ${CODE}. Move the file aside first.`,
      );
    }
  }

  const [issuer, distributor] = await Promise.all([freshAccount(), freshAccount()]);
  const tx = buildIssueTx(await sourceAccount(distributor), issuer.publicKey());
  tx.sign(issuer);
  const { hash } = await signAndSubmit(tx, distributor);
  const createdAt = new Date().toISOString();
  const issuerState: TeurIssuerState = {
    account: issuer.publicKey(),
    secret: issuer.secret(),
    issueHash: hash,
    createdAt,
  };
  writeState("teur-issuer", issuerState);
  const treasury: TreasuryState = {
    code: CODE,
    issuer: issuer.publicKey(),
    account: distributor.publicKey(),
    secret: distributor.secret(),
    trustlineHash: hash,
    createdAt,
  };
  writeState("treasury-teur", treasury);

  // Check what the network now holds, not what was sent.
  const asset = new Asset(CODE, issuer.publicKey());
  const [dist, iss] = await Promise.all([loadAccount(distributor), loadAccount(issuer)]);
  const held = balanceStroops(dist, asset);
  if (held !== toStroops(SUPPLY)) {
    throw new Error(`Distributor holds ${held} stroops of ${CODE} after ${hash}, expected ${toStroops(SUPPLY)}`);
  }
  const flags = Object.entries(iss.flags).filter(([, on]) => on).map(([f]) => f);
  if (flags.length > 0) {
    throw new Error(`Issuer ${issuer.publicKey()} has flags ${flags.join(", ")}; ${CODE} must be a plain asset`);
  }

  console.log(`${CODE} issuer ${issuer.publicKey()}`);
  console.log(`  ${explorerAccountUrl(issuer.publicKey())}`);
  console.log(`${CODE} treasury (distributor) ${distributor.publicKey()} holding ${SUPPLY}`);
  console.log(`  ${explorerAccountUrl(distributor.publicKey())}`);
  console.log(`issue tx ${hash}`);
  console.log(`  ${explorerTxUrl(hash)}`);
  console.log("checked on Horizon: supply held by the distributor, issuer flags all off");
  console.log("secrets saved to scripts/evidence/.state/teur-issuer.json and treasury-teur.json (never commit them)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
