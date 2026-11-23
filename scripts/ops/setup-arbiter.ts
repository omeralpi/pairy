// Creates an arbiter account, the only dispute resolver protected-trade
// escrows name (D2 §9, T2). A fresh Friendbot account, in one transaction,
// adds two signer keys at weight 1, then sets its own key to weight 0 and
// every threshold to 2: both signers must sign, and neither can sign alone.
// The account's own key exists only in memory for this run and is never
// written anywhere.
//
//   pnpm tsx scripts/ops/setup-arbiter.ts <G_omer> <G_ensar>
//     The real arbiter. The two public keys are the builders' Freighter
//     testnet keys (HD-3); their secrets never come near this script. Pin the
//     printed address as ARBITER_ACCOUNT in lib/escrow/config.ts.
//
//   pnpm tsx scripts/ops/setup-arbiter.ts --test
//     The test 2-of-2 for repeated scripted runs (DECISIONS 14): the same
//     shape, with two fresh signer keys saved in
//     scripts/evidence/.state/arbiter-test.json (gitignored). Never pinned,
//     never offered to a user. Refuses while that file exists, so it never
//     overwrites an earlier test arbiter's keys; move the file aside first.
//
// Each run makes a new account. After a testnet reset both modes run again,
// the real one with the same two public keys, and the address is re-pinned.

import {
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { explorerAccountUrl, explorerTxUrl, horizon } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import { freshAccount, loadAccount, signAndSubmit } from "../../tests/integration/testnet";
import { readState, writeState } from "../evidence/record";

const THRESHOLD = 2;

export type ArbiterTestState = {
  account: string;
  signers: { publicKey: string; secret: string }[];
  setupHash: string;
};

async function createArbiter(signers: string[]) {
  const master = await freshAccount();
  const builder = new TransactionBuilder(await loadAccount(master), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  for (const ed25519PublicKey of signers) {
    builder.addOperation(Operation.setOptions({ signer: { ed25519PublicKey, weight: 1 } }));
  }
  const tx = builder
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,
        lowThreshold: THRESHOLD,
        medThreshold: THRESHOLD,
        highThreshold: THRESHOLD,
      }),
    )
    .setTimeout(300)
    .build();
  const { hash } = await signAndSubmit(tx, master);
  return { account: master.publicKey(), hash };
}

/** Reads the account back from Horizon and throws unless it is exactly the 2-of-2. */
async function checkArbiter(account: string, signers: string[]) {
  const acc = await horizon.loadAccount(account);
  const { low_threshold, med_threshold, high_threshold } = acc.thresholds;
  const actual = {
    masterWeight: acc.signers.find((s) => s.key === account)?.weight ?? 0,
    otherSigners: acc.signers
      .filter((s) => s.key !== account)
      .map((s) => `${s.key}:${s.weight}`)
      .sort(),
    thresholds: [low_threshold, med_threshold, high_threshold],
  };
  const expected = {
    masterWeight: 0,
    otherSigners: signers.map((k) => `${k}:1`).sort(),
    thresholds: [THRESHOLD, THRESHOLD, THRESHOLD],
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Arbiter account ${account} is not the expected 2-of-2: ${JSON.stringify(actual)}`);
  }
}

function report(label: string, account: string, hash: string, signers: string[]) {
  console.log(`${label} ${account}`);
  console.log(`  ${explorerAccountUrl(account)}`);
  console.log(`setup tx ${hash}`);
  console.log(`  ${explorerTxUrl(hash)}`);
  for (const s of signers) console.log(`signer ${s} weight 1`);
  console.log("checked on Horizon: own key at weight 0, thresholds 2/2/2, no other signer");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--test") {
    if (readState<ArbiterTestState>("arbiter-test")) {
      throw new Error(
        "scripts/evidence/.state/arbiter-test.json already exists; refusing to overwrite the signer keys of the earlier test arbiter. Move it aside first.",
      );
    }
    const keys = [Keypair.random(), Keypair.random()];
    const signers = keys.map((k) => k.publicKey());
    const { account, hash } = await createArbiter(signers);
    writeState("arbiter-test", {
      account,
      signers: keys.map((k) => ({ publicKey: k.publicKey(), secret: k.secret() })),
      setupHash: hash,
    } satisfies ArbiterTestState);
    await checkArbiter(account, signers);
    report("test arbiter account", account, hash, signers);
    console.log("signer keys saved in scripts/evidence/.state/arbiter-test.json");
    return;
  }

  if (
    args.length !== 2 ||
    !args.every((a) => StrKey.isValidEd25519PublicKey(a)) ||
    args[0] === args[1]
  ) {
    throw new Error(
      "Usage: setup-arbiter.ts <G_omer> <G_ensar> (two different Stellar public keys), or setup-arbiter.ts --test",
    );
  }
  const { account, hash } = await createArbiter(args);
  await checkArbiter(account, args);
  report("arbiter account", account, hash, args);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
