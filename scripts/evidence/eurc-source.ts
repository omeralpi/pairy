// Records one dated attempt at the test EURC source (D3 B4, S-09; FIXES
// X-04): Circle's testnet issuer as Horizon sees it, what the testnet DEX
// would give for XLM, and what the treasury has received against the pass
// mark. Run it on each attempt; the attempts accumulate in
// scripts/evidence/out/eurc-source.json, newest last.
//
//   pnpm tsx scripts/evidence/eurc-source.ts
//
// Reads only the treasury's public address from .state/treasury-eurc.json
// (made by scripts/ops/create-treasury.ts); no secret is read or written.

import { Asset } from "@stellar/stellar-sdk";

import { TESTNET_EURC_ISSUER } from "../../lib/stellar/assets";
import { horizon } from "../../lib/stellar/horizon";
import type { TreasuryState } from "../ops/create-treasury";
import { DECISION_DAY, PASS_MARK, decide, passes, type TreasuryReport } from "./eurc-decision";
import { readOut, readState, writeOut } from "./record";

const EURC = new Asset("EURC", TESTNET_EURC_ISSUER);

const FAUCET = {
  url: "https://faucet.circle.com/",
  network: "Stellar Testnet",
  token: "EURC",
  humanTask: "HX-7: a public web form behind reCAPTCHA, no account; one request per token and network per rate window",
};

type Attempt = {
  at: string;
  issuer: {
    address: string;
    homeDomain: string | null;
    flags: Record<string, boolean>;
    holders: number;
    outstanding: string;
  };
  dex: {
    /** strictSendPaths(native, "100", [EURC]): what 100 XLM would buy. */
    for100Xlm: { destinationAmount: string; path: string[] } | null;
    /** strictReceivePaths([native], EURC, "10"): what 10 EURC would cost. */
    for10Eurc: { sourceAmount: string } | null;
  };
  treasury: (TreasuryReport & { passes: boolean }) | null;
  decision: string;
};

type Record_ = {
  passMark: string;
  decisionDay: string;
  fallback: string;
  faucet: typeof FAUCET;
  attempts: Attempt[];
};

function balanceOf(acc: Awaited<ReturnType<typeof horizon.loadAccount>>, asset: Asset) {
  const line = acc.balances.find(
    (b) => "asset_code" in b && b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  return line?.balance ?? "0.0000000";
}

function fromStroops(n: bigint): string {
  return `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, "0")}`;
}

/**
 * Every EURC credit to the account since it was made, summed: faucet payments
 * included, spending by `acquire` ignored. The decision rests on this, not on
 * the balance.
 */
async function eurcReceived(account: string): Promise<string> {
  let total = 0n;
  let page = await horizon.effects().forAccount(account).order("asc").limit(200).call();
  for (;;) {
    for (const e of page.records) {
      if (
        e.type === "account_credited" &&
        e.asset_code === EURC.code &&
        e.asset_issuer === EURC.issuer
      ) {
        const [whole, frac = ""] = e.amount.split(".");
        total += BigInt(whole + frac.padEnd(7, "0"));
      }
    }
    if (page.records.length < 200) return fromStroops(total);
    page = await page.next();
  }
}

async function attempt(): Promise<Attempt> {
  const [issuerAcc, assets, send, receive] = await Promise.all([
    horizon.loadAccount(TESTNET_EURC_ISSUER),
    horizon.assets().forCode(EURC.code).forIssuer(TESTNET_EURC_ISSUER).call(),
    horizon.strictSendPaths(Asset.native(), "100", [EURC]).call(),
    horizon.strictReceivePaths([Asset.native()], EURC, "10").call(),
  ]);
  const asset = assets.records[0];
  if (!asset) throw new Error(`Horizon lists no asset EURC:${TESTNET_EURC_ISSUER}`);

  const state = readState<TreasuryState>("treasury-eurc");
  let treasury: Attempt["treasury"] = null;
  if (state) {
    const [acc, received] = await Promise.all([
      horizon.loadAccount(state.account),
      eurcReceived(state.account),
    ]);
    treasury = {
      account: state.account,
      eurcReceived: received,
      eurcBalance: balanceOf(acc, EURC),
      passes: passes(received),
    };
  }

  const at = new Date().toISOString();
  return {
    at,
    issuer: {
      address: TESTNET_EURC_ISSUER,
      homeDomain: issuerAcc.home_domain ?? null,
      flags: { ...issuerAcc.flags },
      holders: asset.accounts.authorized,
      outstanding: asset.balances.authorized,
    },
    dex: {
      for100Xlm: send.records[0]
        ? {
            destinationAmount: send.records[0].destination_amount,
            path: send.records[0].path.map((p) => p.asset_code ?? "XLM"),
          }
        : null,
      for10Eurc: receive.records[0] ? { sourceAmount: receive.records[0].source_amount } : null,
    },
    treasury,
    decision: decide(treasury, at.slice(0, 10)),
  };
}

async function main() {
  const next = await attempt();
  const prev = readOut<Record_>("eurc-source");
  writeOut("eurc-source", {
    passMark: PASS_MARK,
    decisionDay: DECISION_DAY,
    fallback: "TEUR, shown as Test EUR, from scripts/ops/issue-test-euro.ts; issuer disclosed in EVIDENCE.md",
    faucet: FAUCET,
    attempts: [...(prev?.attempts ?? []), next],
  } satisfies Record_);
  console.log(`issuer ${next.issuer.address} home_domain ${next.issuer.homeDomain}, ${next.issuer.holders} holders`);
  console.log(`dex: 100 XLM -> ${next.dex.for100Xlm?.destinationAmount ?? "no path"} EURC; 10 EURC costs ${next.dex.for10Eurc?.sourceAmount ?? "no path"} XLM`);
  if (next.treasury) {
    console.log(`treasury ${next.treasury.account} received ${next.treasury.eurcReceived} EURC, holds ${next.treasury.eurcBalance} (pass mark ${PASS_MARK})`);
  }
  console.log(next.decision);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
