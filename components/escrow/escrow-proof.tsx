import { shortAddress, trimAmount } from "@/components/listing/format";
import type { TradeView } from "@/components/trade/format";
import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { netAfterFee } from "@/lib/escrow/fee";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/stellar/horizon";
import { fromStroops, toStroops } from "@/lib/trade/amount";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

/** The published rule, as the acceptance screen links it. */
const ARBITRATION_DOC = "https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md";

/** Who the escrow pays, or has paid, in this state; `net` is the amount after Trustless Work's 0.3%. */
function payout(state: TradeView["state"], disputed: boolean, net: string): { dt: string; dd: string }[] {
  const byTheRule = `${net} USDC to the buyer or the seller, by the rule`;
  switch (state) {
    case "escrow_created":
      return [{ dt: "pays on release", dd: `${net} USDC to the buyer, once it is funded` }];
    case "funded":
      return disputed
        ? [{ dt: "the arbiter pays", dd: byTheRule }]
        : [
            { dt: "pays on release", dd: `${net} USDC to the buyer` },
            { dt: "in a dispute", dd: `the arbiter pays ${byTheRule}` },
          ];
    case "released":
      return [{ dt: "paid", dd: `${net} USDC to the buyer, after Trustless Work's 0.3%` }];
    case "resolved_buyer":
      return [{ dt: "paid by the arbiter", dd: `${net} USDC to the buyer, after Trustless Work's 0.3%` }];
    case "resolved_seller":
      return [{ dt: "paid by the arbiter", dd: `${net} USDC to the seller, after Trustless Work's 0.3%` }];
    default:
      // Cancelled: the escrow pays nobody. (Never funded, or gone with a testnet reset.)
      return [];
  }
}

/**
 * The technical record of a protected trade, collapsed: what the escrow is,
 * who can move it, and the receipts. The protected counterpart of the
 * claimable room's "How this is enforced".
 */
export function EscrowProof({ trade }: { trade: TradeView }) {
  // Truthy, not `!== null`: a trade read without its escrow columns has none.
  const exists = !!trade.createTx && !!trade.escrowContractId;
  const net = fromStroops(netAfterFee(toStroops(trade.amount)));
  const receipts = [
    { label: "Create", hash: trade.createTx },
    { label: "Fund", hash: trade.fundTx },
    { label: "Dispute", hash: trade.disputeTx },
    { label: "Release", hash: trade.releaseTx },
    { label: "Resolve", hash: trade.resolveTx },
  ].filter((r): r is { label: string; hash: string } => !!r.hash);

  return (
    <details className="group border-t border-line pt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        How this is enforced
        <span className="font-mono text-slate group-open:hidden">+</span>
        <span className="hidden font-mono text-slate group-open:inline">−</span>
      </summary>
      <div className="mt-5 space-y-5 text-sm leading-relaxed text-slate">
        <p>
          The {trade.asset} goes into a <span className="text-ink">Trustless Work escrow</span>, a contract on Stellar
          testnet created from a one-time key made in the seller&apos;s browser. Only the seller can release it, and
          only the arbiter account can resolve a dispute, by the published rule. Pairy holds no key, is not a signer
          and cannot move it.
        </p>
        {exists ? (
          <dl className="divide-y divide-line border-y border-line font-mono text-xs">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
              <dt>escrow</dt>
              <dd>
                <a href={trade.viewerUrl ?? undefined} target="_blank" rel="noreferrer" className={linkClass}>
                  {shortAddress(trade.escrowContractId!)} ↗
                </a>
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
              <dt>amount</dt>
              <dd className="text-ink">
                {trimAmount(trade.amount)} {trade.asset}
              </dd>
            </div>
            {payout(trade.state, trade.disputed, net).map((row) => (
              <div key={row.dt} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
                <dt>{row.dt}</dt>
                <dd className="text-ink">{row.dd}</dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
              <dt>release signer · seller</dt>
              <dd className="text-ink">{shortAddress(trade.seller)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
              <dt>receiver · buyer</dt>
              <dd className="text-ink">{shortAddress(trade.buyer)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
              <dt>dispute resolver · arbiter</dt>
              <dd>
                <a href={explorerAccountUrl(ARBITER_ACCOUNT)} target="_blank" rel="noreferrer" className={linkClass}>
                  {shortAddress(ARBITER_ACCOUNT)} ↗
                </a>
              </dd>
            </div>
            {trade.escrowAdmin && (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
                <dt>created by · one-time key</dt>
                <dd className="text-ink">{shortAddress(trade.escrowAdmin)}</dd>
              </div>
            )}
          </dl>
        ) : trade.state === "cancelled" ? (
          <p>No escrow was created.</p>
        ) : (
          <p>No escrow exists yet. Once the seller creates it, its contract, roles and receipts show here.</p>
        )}
        <p>
          To check it yourself, open the escrow on Trustless Work&apos;s viewer: the approver and release signer must be
          the seller, the receiver the buyer, the dispute resolver the arbiter account, and the platform fee 0. In a
          dispute each side has 24 hours to answer one question, and the arbiter applies{" "}
          <a href={ARBITRATION_DOC} target="_blank" rel="noreferrer" className={linkClass}>
            the rule
          </a>{" "}
          within 72 hours. Trustless Work keeps 0.3% of any exit.
        </p>
        {receipts.length > 0 && (
          <ul className="space-y-1 font-mono text-xs">
            {receipts.map((r) => (
              <li key={r.label}>
                {r.label} receipt ·{" "}
                <a href={explorerTxUrl(r.hash)} target="_blank" rel="noreferrer" className={linkClass}>
                  {r.hash.slice(0, 12)}… ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
