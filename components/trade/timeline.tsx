import { ExternalLink } from "lucide-react";

import { roleName, type TradeView } from "@/components/trade/format";

const EVENT_LABEL: Record<string, string> = {
  open: "Trade opened",
  agree: "Terms agreed",
  lock: "Funds locked on-chain",
  claim: "Buyer claimed the funds",
  reclaim: "Seller reclaimed the funds",
  cancel: "Trade cancelled",
  flagDispute: "Problem flagged",
};

export function Timeline({ trade }: { trade: TradeView }) {
  return (
    <ol className="space-y-3 border-l pl-4">
      {trade.events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-pairy-flame" />
          <p className="text-sm font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
          <p className="text-xs text-muted-foreground">
            {e.by === trade.role ? "You" : roleName(e.by as "seller" | "buyer")} ·{" "}
            {e.createdAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </p>
          {e.txUrl && (
            <a
              href={e.txUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs underline decoration-dotted underline-offset-4"
            >
              {e.txHash?.slice(0, 10)}… on stellar.expert <ExternalLink className="size-3" />
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}
