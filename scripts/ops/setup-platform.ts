// Creates the platform account that protected-trade escrows name at a 0 fee
// (D2 §9, T1; S-15). A fresh Friendbot account adds the testnet USDC trustline
// and switches its own key off in the same transaction, so no key can sign for
// it and nobody can use the platform's right to open a dispute.
//
// The key exists only in memory for this run and is never written anywhere;
// after the transaction it has weight 0 and is worthless. Each run makes a new
// account (after a testnet reset, run it again and re-pin PLATFORM_ACCOUNT in
// lib/escrow/config.ts).
//
//   pnpm tsx scripts/ops/setup-platform.ts

import { BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  explorerAccountUrl,
  explorerTxUrl,
  hasTrustline,
  horizon,
} from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import {
  USDC,
  freshAccount,
  loadAccount,
  signAndSubmit,
} from "../../tests/integration/testnet";

async function main() {
  const kp = await freshAccount();
  const tx = new TransactionBuilder(await loadAccount(kp), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .addOperation(Operation.setOptions({ masterWeight: 0 }))
    .setTimeout(300)
    .build();
  const { hash } = await signAndSubmit(tx, kp);
  const address = kp.publicKey();

  // Check what the network now holds, not what was sent.
  const acc = await horizon.loadAccount(address);
  const actual = {
    masterWeight: acc.signers.find((s) => s.key === address)?.weight ?? 0,
    otherSigners: acc.signers.filter((s) => s.key !== address).map((s) => s.key),
    usdcTrustline: hasTrustline(acc, "USDC"),
  };
  const expected = { masterWeight: 0, otherSigners: [], usdcTrustline: true };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Platform account ${address} is not locked as expected after ${hash}: ${JSON.stringify(actual)}`,
    );
  }

  console.log(`platform account ${address}`);
  console.log(`  ${explorerAccountUrl(address)}`);
  console.log(`setup tx ${hash}`);
  console.log(`  ${explorerTxUrl(hash)}`);
  console.log("checked on Horizon: USDC trustline, own key at weight 0, no other signer");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
