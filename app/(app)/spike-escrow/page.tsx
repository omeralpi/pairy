'use client';

// S-06 (WP-20): can a Privy wallet sign Trustless Work's escrow calls through
// Pairy's own signing path? This page takes the checked, unsigned call the
// evidence script handed over (scripts/evidence/escrow-exits.ts release
// --seller=G…), checks it again as the trade room will (validateEscrowCall),
// signs it with the selected wallet (for Privy: Pairy's confirm dialog, then
// Privy signs the hash), sends it to Horizon and reads the escrow back from
// Soroban RPC. Development only: it is not a product screen.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { notFound } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readEscrow } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { decodeEscrowCall, describeEscrowCall, validateEscrowCall, type CallExpectation } from "@/lib/escrow/xdr";
import { explorerTxUrl, horizon, submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { fromStroops, toStroops } from "@/lib/trade/amount";
import { useWalletContext } from "@/lib/wallet/use-wallet";

/** scripts/evidence/.state/handoff-<call>.json, as the script writes it (its `Handoff` type). */
type Handoff = {
  call: "fund" | "release";
  contractId: string;
  unsignedXdr: string;
  txHash: string;
  seller: string;
  amount: string;
  escrow: { buyer: string; admin: string; resolver: string } | null;
};

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export default function SpikeEscrowPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <SpikeEscrow />;
}

function SpikeEscrow() {
  const { wallet, ready, connectPrivy, privy } = useWalletContext();
  const handoffRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState<null | "login" | "sign">(null);
  const [lines, setLines] = useState<string[]>([]);
  const log = (line: string) => setLines((l) => [...l, `${new Date().toISOString().slice(11, 23)} ${line}`]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      log(`error: ${message(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const login = () =>
    run("login", async () => {
      const w = await connectPrivy!();
      log(`wallet selected: ${w.kind} ${w.publicKey}`);
    });

  const sign = () =>
    run("sign", async () => {
      if (!wallet) throw new Error("No wallet is selected.");
      const h = JSON.parse(handoffRef.current?.value ?? "") as Handoff;
      if (h.seller !== wallet.publicKey) throw new Error(`The handoff names ${h.seller} as the seller, not this wallet.`);
      const decoded = decodeEscrowCall({ unsignedXdr: h.unsignedXdr, txHash: h.txHash });
      // Rebuilt by Pairy's own rule (expectedTerms, with the selected wallet as seller) from the handoff's public facts,
      // which stand in for the trade record here; the handoff never supplies the check itself.
      const expectation: CallExpectation =
        h.call === "fund"
          ? {
              kind: "fund",
              contractId: h.contractId,
              seller: wallet.publicKey,
              amountStroops: toStroops(h.amount),
              terms: expectedTerms(
                { buyer: h.escrow!.buyer, seller: wallet.publicKey, amount: h.amount, escrowAdmin: h.escrow!.admin },
                { resolver: h.escrow!.resolver },
              ),
            }
          : { kind: "release", contractId: h.contractId, seller: wallet.publicKey };
      const problems = validateEscrowCall(decoded, expectation);
      if (problems.length) {
        problems.forEach((p) => log(`refused: ${p}`));
        throw new Error(`validateEscrowCall refused the ${h.call}; nothing was signed.`);
      }
      const summary = describeEscrowCall(decoded);
      log(`validateEscrowCall: no problems with the ${h.call} (${decoded.fn} on ${decoded.contractId}, fee up to ${fromStroops(decoded.fee)} XLM)`);
      log(`asking the ${wallet.kind} wallet to sign: "${summary}"`);

      const started = performance.now();
      const signed = await wallet.signTransaction(h.unsignedXdr, { summary });
      const tx = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction;
      const hash = hex(tx.hash());
      log(
        `signed in ${Math.round(performance.now() - started)} ms: ${tx.signatures.length} signature(s) on the envelope; hash ${hash} ${
          hash === h.txHash ? "equals" : "differs from"
        } Trustless Work's txHash`,
      );

      const res = await submit(tx);
      log(`Horizon accepted ${res.hash} in ledger ${res.ledger}: ${explorerTxUrl(res.hash)}`);
      const rec = await horizon.transactions().transaction(res.hash).call();
      log(`read back from Horizon: successful ${rec.successful}, source ${rec.source_account}, ${rec.signatures.length} signature(s), fee charged ${rec.fee_charged} stroops`);

      // Soroban RPC is a separate service: read once it has seen the ledger the call landed in.
      let escrow = await readEscrow(h.contractId);
      for (let i = 0; i < 20 && escrow.ttl.latestLedger < res.ledger; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        escrow = await readEscrow(h.contractId);
      }
      const { status } = escrow;
      log(
        `escrow ${h.contractId} on Soroban RPC (ledger ${escrow.ttl.latestLedger}): balance ${fromStroops(status.balanceStroops)} USDC, released ${status.released}, disputed ${status.disputed}`,
      );
      const ok = h.call === "fund" ? status.balanceStroops === toStroops(h.amount) : status.released && status.balanceStroops === 0n;
      log(`S-06 ${h.call}: ${ok ? "PASS" : "FAIL"} (${h.call === "fund" ? `balance ${ok ? "equals" : "is not"} ${h.amount} USDC` : `released ${status.released}, balance ${fromStroops(status.balanceStroops)}`})`);
    });

  if (!ready) return <main className="mx-auto max-w-2xl px-4 py-8 text-sm text-slate">Loading your wallet…</main>;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight">S-06: this wallet signs an escrow call</h1>
      <p className="text-sm text-slate">
        Wallet: {wallet ? <span className="font-mono text-ink">{wallet.kind} {wallet.publicKey}</span> : "none selected"}. Privy:{" "}
        {privy.enabled ? (privy.ready ? (privy.authenticated ? "logged in" : "ready") : privy.failed ? "failed" : "loading") : "disabled"}.
      </p>
      {connectPrivy && (
        <Button disabled={busy !== null || !privy.ready} onClick={login}>
          {busy === "login" ? "Opening Privy…" : "Continue with Privy"}
        </Button>
      )}
      <Textarea ref={handoffRef} id="handoff" rows={8} className="font-mono text-xs" placeholder="Paste scripts/evidence/.state/handoff-<call>.json" />
      <Button disabled={!wallet || busy !== null} onClick={sign}>
        {busy === "sign" ? "Signing…" : "Check and sign"}
      </Button>
      <pre id="log" className="whitespace-pre-wrap break-all rounded-md bg-sand p-3 text-xs">
        {lines.join("\n")}
      </pre>
    </main>
  );
}
