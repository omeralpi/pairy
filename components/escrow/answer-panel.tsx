'use client';

import { useState } from "react";

import { ConfirmAction } from "@/components/confirm-action";
import { friendlyError } from "@/components/friendly-error";
import { countdown, shortWhen, type TradeView } from "@/components/trade/format";
import { useNow } from "@/components/trade/use-now";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { NOTE_MAX } from "@/lib/escrow/config";
import { resolutionReady, ruleOutcome } from "@/lib/escrow/rule";
import type { TradeRole } from "@/lib/trade/state-machine";
import { cn } from "@/lib/utils";

const ARBITRATION_DOC = "https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md";
const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

type Given = TradeView["answers"]["seller"];

const yesNo = (a: NonNullable<Given>) => (a.cashHandedOver ? "Yes" : "No");

/** One side's answer as the viewer reads it: "You answered No." / "The buyer sent no answer." */
function AnswerLine({ who, answer, open }: { who: "You" | `The ${TradeRole}`; answer: Given; open?: Date }) {
  if (answer) {
    return (
      <div className="space-y-1">
        <p className="text-ink">
          {who} answered {yesNo(answer)}.
        </p>
        {answer.note && <p className="border-l-2 border-line pl-4 text-sm leading-relaxed text-slate [overflow-wrap:anywhere]">{answer.note}</p>}
      </div>
    );
  }
  if (open) {
    return (
      <p className="text-slate">
        {who} hasn&apos;t answered yet. They have until {shortWhen(open)}.
      </p>
    );
  }
  return <p className="text-slate">{who} sent no answer.</p>;
}

/**
 * Once the escrow is disputed, each trader answers the published rule's one
 * question, once, after a confirm (DECISIONS 10), within 24 hours of when
 * Pairy recorded the dispute (DECISIONS 1). Both answers and notes are shown
 * to both; once both answered or the window closed, the rule's outcome. After
 * the arbiter settles, the answers stay with the rule that applied.
 */
export function AnswerPanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const now = useNow();
  // The answer is final; whatever the server says, show where the trade stands now.
  const send = api.escrow.answer.useMutation({ onSettled: () => utils.trade.invalidate() });
  const [draft, setDraft] = useState<{ cash: boolean | null; note: string }>({ cash: null, note: "" });
  const other: TradeRole = trade.role === "seller" ? "buyer" : "seller";
  const mine = trade.answers[trade.role];
  const theirs = trade.answers[other];
  const given = { seller: trade.answers.seller?.cashHandedOver ?? null, buyer: trade.answers.buyer?.cashHandedOver ?? null };
  const rule = ruleOutcome(given);

  const heading = (
    <div className="space-y-3">
      <p className="eyebrow">The dispute</p>
      <h2 id="answer-heading" className="text-3xl font-semibold tracking-tight">
        Was the cash handed over in full?
      </h2>
    </div>
  );

  if (trade.state === "resolved_buyer" || trade.state === "resolved_seller") {
    const paid: TradeRole = trade.state === "resolved_buyer" ? "buyer" : "seller";
    return (
      <section className="space-y-6" aria-labelledby="answer-heading">
        {heading}
        <div className="space-y-3">
          <AnswerLine who="You" answer={mine} />
          <AnswerLine who={`The ${other}`} answer={theirs} />
        </div>
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          {rule.outcome === paid
            ? `The arbiter applied rule ${rule.rule}: all to the ${paid}.`
            : `The arbiter paid all to the ${paid}; the answers give all to the ${rule.outcome} (rule ${rule.rule}).`}
        </p>
      </section>
    );
  }

  // Recorded disputes always carry both (escrow.recordDispute, sync).
  if (!trade.answerDeadline || !trade.promiseDeadline) return null;
  const deadline = trade.answerDeadline;
  // The server's "Answers closed at …" settles it when this device's clock is behind.
  const closedByServer = send.error?.message.startsWith("Answers closed at") ?? false;
  const open = now < deadline.getTime() && !closedByServer;
  const ready = closedByServer || resolutionReady(given, deadline, new Date(now));
  const failure = send.error && !closedByServer ? friendlyError(send.error) : null;

  function answer() {
    if (draft.cash === null) return;
    send.mutate({ tradeId: trade.id, cashHandedOver: draft.cash, note: draft.note.trim() || undefined });
  }

  return (
    <section className="space-y-8" aria-labelledby="answer-heading">
      <div className="space-y-5">
        {heading}
        <p className="text-sm leading-relaxed text-slate">
          The arbiter doesn&apos;t judge: your two answers decide, by the published rule.{" "}
          <a href={ARBITRATION_DOC} target="_blank" rel="noreferrer" className={linkClass}>
            Read the rule ↗
          </a>
        </p>
      </div>

      {!mine && open && (
        <div className="space-y-6">
          <div className="space-y-1">
            <p className="text-lg text-ink">
              Answer by {shortWhen(deadline)} · <span className="font-mono tabular-nums">{countdown(deadline.getTime() - now)} left</span>
            </p>
            <p className="text-sm leading-relaxed text-slate">
              {trade.role === "seller"
                ? "If you send no answer by then and the buyer answers yes, the buyer is paid."
                : "If you send no answer by then, you are paid only if the seller answers yes."}
            </p>
          </div>
          <div role="group" aria-label="Your answer" className="grid grid-cols-2 rounded-full border border-line p-1">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                type="button"
                aria-pressed={draft.cash === v}
                onClick={() => setDraft({ ...draft, cash: v })}
                className={cn(
                  "rounded-full px-3 py-2.5 text-sm font-medium transition-colors",
                  draft.cash === v ? "bg-ink text-paper" : "text-slate hover:text-ink",
                )}
              >
                {v ? "Yes" : "No"}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="answer-note" className="eyebrow text-[11px] font-normal">
              Note · optional
            </Label>
            <Textarea
              id="answer-note"
              className="border-line bg-paper text-base text-ink shadow-none placeholder:text-slate focus-visible:ring-ink md:text-base"
              rows={3}
              maxLength={NOTE_MAX}
              placeholder="No names, phone numbers or other personal details."
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <p className="flex justify-between gap-4 font-mono text-xs text-slate">
              <span>shown to the other trader and the arbiter; deleted when the trade ends</span>
              <span>
                {draft.note.length}/{NOTE_MAX}
              </span>
            </p>
          </div>
          <ConfirmAction
            title="Are you sure? Your answer cannot be changed."
            description={
              draft.cash
                ? `You answer Yes: the cash was handed over in full.${draft.note.trim() ? " Your note goes with it." : ""}`
                : `You answer No: the cash was not handed over in full.${draft.note.trim() ? " Your note goes with it." : ""}`
            }
            confirmLabel="Send my answer"
            onConfirm={answer}
          >
            <Button variant="beacon" size="lg" className="w-full" disabled={draft.cash === null || send.isPending}>
              Send my answer
            </Button>
          </ConfirmAction>
        </div>
      )}

      <div className="space-y-3">
        {mine ? (
          <AnswerLine who="You" answer={mine} />
        ) : (
          !open && <p className="text-ink">Answers closed at {shortWhen(deadline)}. You sent no answer.</p>
        )}
        <AnswerLine who={`The ${other}`} answer={theirs} open={open ? deadline : undefined} />
      </div>

      {ready ? (
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          The rule gives: all to the {rule.outcome} (rule {rule.rule}). The arbiter signs by {shortWhen(trade.promiseDeadline)}.
        </p>
      ) : (
        mine && <p className="text-sm text-slate">The arbiter applies the rule by {shortWhen(trade.promiseDeadline)}.</p>
      )}

      {failure && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger [overflow-wrap:anywhere]">
          {failure}
        </p>
      )}
    </section>
  );
}
