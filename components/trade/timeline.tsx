import { trimAmount } from "@/components/listing/format";
import { shortWhen, type TradeView } from "@/components/trade/format";

/** One plain sentence per event, from the viewer's side. */
function sentence(type: string, by: string, mine: boolean, trade: Pick<TradeView, "asset" | "amount" | "mode" | "state">): string {
  const who = mine ? "You" : `The ${by}`;
  const escrow = trade.mode === "protected";
  switch (type) {
    case "open":
      return escrow ? `${who} opened the trade and accepted the protected-trade terms.` : `${who} opened the trade.`;
    case "agree":
      return escrow ? `${who} agreed and accepted the protected-trade terms.` : `${who} agreed.`;
    case "lock":
      return `${who} locked the ${trade.asset}.`;
    case "claim":
      return `${who} claimed the ${trade.asset}.`;
    case "reclaim":
      return `${who} took the ${trade.asset} back.`;
    case "cancel":
      return `${who} cancelled.`;
    case "expire":
      return "Cancelled automatically after a week without activity.";
    case "reset":
      return "Closed: Stellar testnet was reset.";
    case "flagDispute":
      return `${who} flagged a problem.`;
    // Protected trades: each of these was read from the chain, except the answers.
    case "escrowCreate":
      return `${who} created the escrow.`;
    case "fund":
      return `${who} funded the escrow with ${trimAmount(trade.amount)} ${trade.asset}.`;
    case "release":
      return `${who} released the escrow to the buyer, less Trustless Work's 0.3%.`;
    case "escrowDispute":
      return `${who} opened a dispute on the escrow.`;
    case "answerYes":
      return `${who} answered: the cash was handed over in full.`;
    case "answerNo":
      return `${who} answered: the cash was not handed over in full.`;
    case "resolve": {
      // The outcome is the state the resolution left the trade in.
      const outcome = trade.state === "resolved_buyer" ? "buyer" : trade.state === "resolved_seller" ? "seller" : null;
      return outcome ? `The arbiter settled the dispute: all to the ${outcome}, less 0.3%.` : "The arbiter settled the dispute.";
    }
    default:
      return `${who}: ${type}.`;
  }
}

export function Timeline({ trade }: { trade: TradeView }) {
  return (
    <ol className="divide-y divide-line border-y border-line">
      {trade.events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <p className="text-sm text-ink">{sentence(e.type, e.by, e.by === trade.role, trade)}</p>
          <p className="flex items-baseline gap-4 font-mono text-xs text-slate">
            <time dateTime={e.createdAt.toISOString()}>{shortWhen(e.createdAt)}</time>
            {e.txUrl && (
              <a
                href={e.txUrl}
                target="_blank"
                rel="noreferrer"
                className="text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
              >
                Receipt ↗
              </a>
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}
