import { shortWhen, type TradeView } from "@/components/trade/format";

/** One plain sentence per event, from the viewer's side. */
function sentence(type: string, by: string, mine: boolean, asset: string): string {
  const who = mine ? "You" : `The ${by}`;
  switch (type) {
    case "open":
      return `${who} opened the trade.`;
    case "agree":
      return `${who} agreed.`;
    case "lock":
      return `${who} locked the ${asset}.`;
    case "claim":
      return `${who} claimed the ${asset}.`;
    case "reclaim":
      return `${who} took the ${asset} back.`;
    case "cancel":
      return `${who} cancelled.`;
    case "flagDispute":
      return `${who} flagged a problem.`;
    default:
      return `${who}: ${type}.`;
  }
}

export function Timeline({ trade }: { trade: TradeView }) {
  return (
    <ol className="divide-y divide-line border-y border-line">
      {trade.events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <p className="text-sm text-ink">{sentence(e.type, e.by, e.by === trade.role, trade.asset)}</p>
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
