'use client';

import { ACCEPTANCE_ITEMS, ACCEPTANCE_TITLE, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { explorerAccountUrl } from "@/lib/stellar/horizon";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

/** The published rule this text ends (WP-01). */
const ARBITRATION_DOC = "https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md";

/**
 * The protected-trade terms, word for word as docs/arbitration.md publishes
 * them, and the version a trader accepts: the caller sends ACCEPTANCE_VERSION
 * with the open or the agree. Ticking the box is the acceptance; nothing is
 * stored until the caller's button is pressed.
 */
export function AcceptanceScreen({
  accepted,
  onAcceptedChange,
}: {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}) {
  return (
    <section aria-labelledby="acceptance-title" className="space-y-4 rounded-xl border border-line p-5">
      <h2 id="acceptance-title" className="text-lg font-semibold tracking-tight text-ink">
        {ACCEPTANCE_TITLE}
      </h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink marker:text-slate">
        {ACCEPTANCE_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <ul className="space-y-1 text-sm">
        <li>
          <a href={explorerAccountUrl(ARBITER_ACCOUNT)} target="_blank" rel="noreferrer" className={linkClass}>
            The arbiter account, its signers and thresholds, on stellar.expert ↗
          </a>
        </li>
        <li>
          <a href={ARBITRATION_DOC} target="_blank" rel="noreferrer" className={linkClass}>
            The arbitration rule in full ↗
          </a>
        </li>
      </ul>
      <p className="break-all font-mono text-xs text-slate">Text version {ACCEPTANCE_VERSION}</p>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm leading-relaxed">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-ink"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
        />
        <span>I accept</span>
      </label>
    </section>
  );
}
