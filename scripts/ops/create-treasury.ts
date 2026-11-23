// Creates the team treasury account that holds the test euro for the evidence
// scripts (D3 B4, S-09; FIXES X-04). A fresh Friendbot account adds the
// asset's trustline; Circle's faucet (HX-7, a human web form) then pays test
// EURC to the printed address, and the evidence scripts' `acquire` pays from
// it (WP-11, WP-23). A team test key, never a Pairy server key (I1).
//
//   pnpm tsx scripts/ops/create-treasury.ts EURC
//
// The secret goes to scripts/evidence/.state/treasury-eurc.json (gitignored,
// 0600) and nowhere else. Refuses while that file exists, so a treasury that
// may already hold faucet EURC is never replaced; move the file aside first.
// After a testnet reset, run it again and ask the faucet again.

import { Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import { TESTNET_EURC_ISSUER } from "../../lib/stellar/assets";
import { explorerAccountUrl, explorerTxUrl, horizon } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import { freshAccount, loadAccount, signAndSubmit } from "../../tests/integration/testnet";
import { readState, writeState } from "../evidence/record";

/** The TEUR treasury is the distributor that issue-test-euro.ts makes. */
const ISSUERS = { EURC: TESTNET_EURC_ISSUER } as const;

/** scripts/evidence/.state/treasury-<code>.json: the account `acquire` pays from. */
export type TreasuryState = {
  code: string;
  issuer: string;
  account: string;
  secret: string;
  trustlineHash: string;
  createdAt: string;
};

async function main() {
  const code = process.argv[2];
  if (code !== "EURC") {
    throw new Error("Usage: pnpm tsx scripts/ops/create-treasury.ts EURC");
  }
  const name = `treasury-${code.toLowerCase()}`;
  const existing = readState<TreasuryState>(name);
  if (existing) {
    throw new Error(
      `scripts/evidence/.state/${name}.json already exists (account ${existing.account}); refusing to overwrite a treasury that may hold faucet ${code}.`,
    );
  }
  const issuer = ISSUERS[code];
  const asset = new Asset(code, issuer);

  const kp = await freshAccount();
  const tx = new TransactionBuilder(await loadAccount(kp), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(300)
    .build();
  const { hash } = await signAndSubmit(tx, kp);
  const account = kp.publicKey();
  const state: TreasuryState = {
    code,
    issuer,
    account,
    secret: kp.secret(),
    trustlineHash: hash,
    createdAt: new Date().toISOString(),
  };
  writeState(name, state);

  // Check what the network now holds, not what was sent.
  const acc = await horizon.loadAccount(account);
  const trusted = acc.balances.some(
    (b) => "asset_code" in b && b.asset_code === code && b.asset_issuer === issuer,
  );
  if (!trusted) {
    throw new Error(`Treasury ${account} shows no ${code}:${issuer} trustline after ${hash}`);
  }

  console.log(`${code} treasury ${account}`);
  console.log(`  ${explorerAccountUrl(account)}`);
  console.log(`trustline tx ${hash}`);
  console.log(`  ${explorerTxUrl(hash)}`);
  console.log(`secret saved to scripts/evidence/.state/${name}.json (never commit it)`);
  console.log(`next: paste the address above into Circle's faucet (Stellar Testnet, ${code})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
