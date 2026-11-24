import { Check, X } from "lucide-react";

import type { TermRow } from "@/components/escrow/escrow-steps";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

/**
 * The escrow's terms as this browser read them from Stellar testnet, one row
 * each, ✓ or ✗ with what differs (D2 §7.3). The viewer link lets the seller
 * check the same escrow on Trustless Work's own page (G3).
 */
export function TermCheckList({ rows, viewerUrl }: { rows: TermRow[]; viewerUrl: string | null }) {
  return (
    <div className="space-y-3">
      <p className="eyebrow">The escrow on Stellar testnet</p>
      <p className="text-sm leading-relaxed text-slate">
        Read by this browser straight from Stellar testnet, not through Pairy or Trustless Work.
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} data-term={r.id} data-ok={r.problem === null} className="flex gap-3 text-sm">
            {r.problem === null ? (
              <Check className="mt-0.5 size-4 shrink-0 text-slate" strokeWidth={1.5} aria-label="Matches" />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-label="Differs" />
            )}
            {r.problem === null ? (
              <span className="text-slate [overflow-wrap:anywhere]">
                {r.label} · <span className="text-ink">{r.value}</span>
              </span>
            ) : (
              <span className="font-medium text-ink [overflow-wrap:anywhere]">{r.problem}</span>
            )}
          </li>
        ))}
      </ul>
      {viewerUrl && (
        <a href={viewerUrl} target="_blank" rel="noreferrer" className={`inline-block text-sm ${linkClass}`}>
          Check it on Trustless Work&apos;s viewer ↗
        </a>
      )}
    </div>
  );
}
