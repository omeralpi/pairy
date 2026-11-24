import { trimAmount } from "@/components/listing/format";
import type { TradeView } from "@/components/trade/format";
import { netAfterFee } from "@/lib/escrow/fee";
import { fromStroops, toStroops } from "@/lib/trade/amount";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

/**
 * The buyer's view of a funded escrow with no dispute (D2 §7.3). The status
 * line above already says to let go of the cash only when the release shows
 * on this screen; this says what the release pays and how it shows. There is
 * no claim in a protected trade: the buyer signs nothing.
 */
export function BuyerWaiting({ trade }: { trade: TradeView }) {
  const net = fromStroops(netAfterFee(toStroops(trade.amount)));
  return (
    <section className="space-y-3">
      <p className="leading-relaxed text-slate">
        {`The escrow holds ${trimAmount(trade.amount)} USDC. When the seller releases it, you receive ${net} USDC; 0.3% goes to Trustless Work. You sign nothing: this page says "Settled" once the release is on Stellar testnet. The seller's screen is not proof.`}
      </p>
      {trade.viewerUrl && (
        <a href={trade.viewerUrl} target="_blank" rel="noreferrer" className={`inline-block text-sm ${linkClass}`}>
          Check it on Trustless Work&apos;s viewer ↗
        </a>
      )}
    </section>
  );
}
