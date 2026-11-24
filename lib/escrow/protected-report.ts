// Every protected trade, for EVIDENCE.md (WP-41): each dispute's times, both
// answers with when they were given, the outcome the published rule gives and
// the one the chain shows, every resolution prepared in Pairy with its hash,
// and every missed 72-hour promise (resolved_at − disputed_at > 72 h, or never
// resolved: still open after 72 h, or closed by the testnet reset; O-35).
//
// Read only: one read-only transaction, so Postgres itself refuses any write;
// no chain call; nothing signed. The notes, the chat and the transactions'
// XDR are never read, and of the trade events only the resets. A value that
// was not recorded shows as "not recorded".
// Run by scripts/ops/protected-report.ts.

import { and, asc, eq, inArray } from "drizzle-orm";

import { arbiterResolutions, disputeAnswers, tradeEvents, trades } from "@/lib/db/schema";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/stellar/horizon";
import { fromStroops, toStroops, trimAmount } from "@/lib/trade/amount";
import type { Database } from "@/lib/trade/persist";
import { isTerminal, type TradeRole, type TradeState } from "@/lib/trade/state-machine";

import { ARBITER_PROMISE_MS, TW_FEE_ADDRESS, twViewerUrl } from "./config";
import { netAfterFee } from "./fee";
import { answerDeadline, promiseDeadline, resolutionReady, ruleOutcome, type Outcome } from "./rule";

/** F-11, as server/api/routers/arbiter.ts reads it: a resolution stored without an expiry expires 10 minutes after it was made. */
const NO_EXPIRY_MS = 10 * 60_000;

type Link = { hash: string; url: string };
type TimedAnswer = { cashHandedOver: boolean; answeredAt: Date } | null;

/**
 * prepared: no signature yet. collecting: some. signed: every signature the
 * arbiter's threshold needs, not recorded by Pairy. landed: the resolve the
 * trade recorded. expired: its window closed (marked or not). failed: fully
 * signed and never landed.
 */
export type ResolutionStatus = "prepared" | "collecting" | "signed" | "landed" | "expired" | "failed";

/**
 * kept / late: resolved within / more than 72 h after the dispute's ledger
 * time. open: not resolved, inside the 72 h. missed: never resolved within
 * 72 h: still open after them, or the trade ended without a resolution (the
 * testnet reset closes funded trades), whenever it ended (O-35). null: a time
 * it needs was not recorded.
 */
export type PromiseState = "kept" | "late" | "open" | "missed" | null;

export type ReportResolution = {
  id: string;
  status: ResolutionStatus;
  stored: (typeof arbiterResolutions.$inferSelect)["status"];
  outcome: Outcome;
  rule: number;
  recipient: string;
  /** The whole escrow balance at prepare time. */
  amount: string;
  /** What the payee receives: the amount less Trustless Work's 0.3% fee. */
  net: string;
  txHash: string;
  /** stellar.expert, only for the one that landed: the others are not on chain. */
  url: string | null;
  signers: string[];
  preparedBy: string;
  preparedAt: Date;
  validUntil: Date;
};

export type ReportDispute = {
  openedBy: TradeRole | null;
  /** The dispute transaction's ledger time; the 72 h promise counts from it. */
  disputedAt: Date | null;
  /** When Pairy recorded the dispute; the 24 h answer window counts from it (DECISIONS 1). */
  recordedAt: Date | null;
  answersDue: Date | null;
  promisedBy: Date | null;
  answers: { seller: TimedAnswer; buyer: TimedAnswer };
  /** What the published rule gives, once it applies: both answered, the window closed, or the trade ended. */
  rule: { outcome: Outcome; rule: 1 | 2 | 3 } | null;
  resolvedTo: Outcome | null;
  resolvedAt: Date | null;
  followsRule: boolean | null;
  promise: PromiseState;
  /** From the dispute to its resolution; if none, to the trade's end or to now. */
  tookMs: number | null;
};

export type ReportTrade = {
  id: string;
  state: TradeState;
  amount: string;
  seller: string;
  buyer: string;
  openedAt: Date;
  contractId: string | null;
  viewerUrl: string | null;
  steps: Record<"create" | "fund" | "release" | "dispute" | "resolve", Link | null>;
  fundedAt: Date | null;
  /** When Pairy recorded the trade's end. */
  endedAt: Date | null;
  /** When scripts/ops/testnet-reset.ts closed the trade (its trade_events row), or null. */
  resetAt: Date | null;
  dispute: ReportDispute | null;
  resolutions: ReportResolution[];
};

export type ProtectedReport = {
  generatedAt: Date;
  /** Signatures a resolve needs, from Horizon; null when it could not be read. */
  threshold: number | null;
  /** The fee address Pairy's checks require in every release and resolution it records. */
  feeAddress: string | null;
  trades: ReportTrade[];
};

type TradeRow = typeof trades.$inferSelect;
type AnswerRow = { tradeId: string; role: TradeRole; cashHandedOver: boolean; answeredAt: Date };
type ResetRow = { tradeId: string; createdAt: Date };
type ResolutionRow = Omit<typeof arbiterResolutions.$inferSelect, "unsignedXdr" | "signedXdr" | "submittedTx">;

const link = (hash: string | null): Link | null => (hash ? { hash, url: explorerTxUrl(hash) } : null);

function resolutionView(r: ResolutionRow, trade: TradeRow, threshold: number | null, now: Date): ReportResolution {
  const validUntil = r.expiresAt ?? new Date(r.createdAt.getTime() + NO_EXPIRY_MS);
  // Landed = the resolve the trade recorded after reading it back from Horizon, whatever the row
  // says: recordResolution marks only that hash submitted, and sync may record it first (WP-29 N6).
  const landed = r.txHash === trade.resolveTx;
  let status: ResolutionStatus;
  if (landed) status = "landed";
  else if (r.status === "failed") status = "failed";
  else if (r.status === "expired" || validUntil.getTime() <= now.getTime()) status = "expired";
  else if (threshold !== null && r.signers.length >= threshold) status = "signed";
  else status = r.signers.length ? "collecting" : "prepared";
  return {
    id: r.id,
    status,
    stored: r.status,
    outcome: r.outcome,
    rule: r.rule,
    recipient: r.recipient,
    amount: r.amount,
    net: fromStroops(netAfterFee(toStroops(r.amount))),
    txHash: r.txHash,
    url: landed ? explorerTxUrl(r.txHash) : null,
    signers: r.signers,
    preparedBy: r.preparedBy,
    preparedAt: r.createdAt,
    validUntil,
  };
}

function disputeView(t: TradeRow, answerRows: AnswerRow[], now: Date): ReportDispute {
  const said = (role: TradeRole): TimedAnswer => {
    const a = answerRows.find((x) => x.tradeId === t.id && x.role === role);
    return a ? { cashHandedOver: a.cashHandedOver, answeredAt: a.answeredAt } : null;
  };
  const answers = { seller: said("seller"), buyer: said("buyer") };
  const given = { seller: answers.seller?.cashHandedOver ?? null, buyer: answers.buyer?.cashHandedOver ?? null };
  const answersDue = t.disputeRecordedAt && answerDeadline({ disputeRecordedAt: t.disputeRecordedAt });
  const ended = isTerminal(t.state);
  // Answers are final once both are in, the window closed, or the trade ended (none are taken after that).
  const final = ended || (answersDue ? resolutionReady(given, answersDue, now) : given.seller !== null && given.buyer !== null);
  const rule = final ? ruleOutcome(given) : null;
  const resolvedTo: Outcome | null = t.state === "resolved_buyer" ? "buyer" : t.state === "resolved_seller" ? "seller" : null;

  const end = resolvedTo ? t.resolvedAt : ended ? t.updatedAt : now;
  const tookMs = t.disputedAt && end ? end.getTime() - t.disputedAt.getTime() : null;
  let promise: PromiseState = null;
  if (tookMs !== null) {
    const over = tookMs > ARBITER_PROMISE_MS;
    if (resolvedTo) promise = over ? "late" : "kept";
    // Ended without a resolution: missed, even inside the 72 h (O-35).
    else promise = over || ended ? "missed" : "open";
  }
  return {
    openedBy: t.disputeOpenedBy,
    disputedAt: t.disputedAt,
    recordedAt: t.disputeRecordedAt,
    answersDue,
    promisedBy: t.disputedAt && promiseDeadline({ disputedAt: t.disputedAt }),
    answers,
    rule,
    resolvedTo,
    resolvedAt: resolvedTo ? t.resolvedAt : null,
    followsRule: resolvedTo && rule ? resolvedTo === rule.outcome : null,
    promise,
    tookMs,
  };
}

export async function protectedReport(
  db: Database,
  { now, threshold }: { now: Date; threshold: number | null },
): Promise<ProtectedReport> {
  // One snapshot, and Postgres refuses any write in it.
  const { rows, answers, resolutions, resets } = await db.transaction(
    async (tx) => {
      const rows = await tx.select().from(trades).where(eq(trades.mode, "protected")).orderBy(asc(trades.createdAt), asc(trades.id));
      const ids = rows.map((t) => t.id);
      if (!ids.length) return { rows, answers: [] as AnswerRow[], resolutions: [] as ResolutionRow[], resets: [] as ResetRow[] };
      // Explicit columns: never the notes, never the XDR.
      const answers: AnswerRow[] = await tx
        .select({
          tradeId: disputeAnswers.tradeId,
          role: disputeAnswers.role,
          cashHandedOver: disputeAnswers.cashHandedOver,
          answeredAt: disputeAnswers.answeredAt,
        })
        .from(disputeAnswers)
        .where(inArray(disputeAnswers.tradeId, ids));
      const resolutions: ResolutionRow[] = await tx
        .select({
          id: arbiterResolutions.id,
          tradeId: arbiterResolutions.tradeId,
          outcome: arbiterResolutions.outcome,
          rule: arbiterResolutions.rule,
          recipient: arbiterResolutions.recipient,
          amount: arbiterResolutions.amount,
          txHash: arbiterResolutions.txHash,
          signers: arbiterResolutions.signers,
          status: arbiterResolutions.status,
          preparedBy: arbiterResolutions.preparedBy,
          expiresAt: arbiterResolutions.expiresAt,
          createdAt: arbiterResolutions.createdAt,
        })
        .from(arbiterResolutions)
        .where(inArray(arbiterResolutions.tradeId, ids))
        .orderBy(asc(arbiterResolutions.createdAt), asc(arbiterResolutions.id));
      // Who closed a trade without a resolution: only the reset's row, no other event.
      const resets: ResetRow[] = await tx
        .select({ tradeId: tradeEvents.tradeId, createdAt: tradeEvents.createdAt })
        .from(tradeEvents)
        .where(and(inArray(tradeEvents.tradeId, ids), eq(tradeEvents.type, "reset")));
      return { rows, answers, resolutions, resets };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  const resetOf = (id: string) => resets.find((x) => x.tradeId === id)?.createdAt ?? null;
  return {
    generatedAt: now,
    threshold,
    feeAddress: TW_FEE_ADDRESS,
    trades: rows.map((t) => ({
      id: t.id,
      state: t.state,
      amount: t.amount,
      seller: t.seller,
      buyer: t.buyer,
      openedAt: t.createdAt,
      contractId: t.escrowContractId,
      viewerUrl: t.escrowContractId ? twViewerUrl(t.escrowContractId) : null,
      steps: {
        create: link(t.createTx),
        fund: link(t.fundTx),
        release: link(t.releaseTx),
        dispute: link(t.disputeTx),
        resolve: link(t.resolveTx),
      },
      fundedAt: t.fundedAt,
      endedAt: isTerminal(t.state) ? t.updatedAt : null,
      resetAt: resetOf(t.id),
      dispute: t.disputed || t.disputeTx ? disputeView(t, answers, now) : null,
      resolutions: resolutions.filter((r) => r.tradeId === t.id).map((r) => resolutionView(r, t, threshold, now)),
    })),
  };
}

// ---- Markdown, in EVIDENCE.md's style ----

const NOT_RECORDED = "not recorded";
const OUTCOME = { buyer: "all to the buyer", seller: "all back to the seller" } as const;

const time = (d: Date | null) => (d ? `${d.toISOString().slice(0, 19).replace("T", " ")} UTC` : NOT_RECORDED);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const account = (key: string) => `[\`${short(key)}\`](${explorerAccountUrl(key)})`;
const txHash = (hash: string) => `\`${hash.slice(0, 8)}…${hash.slice(-4)}\``;
const txLink = (l: Link | null) => (l ? `[${txHash(l.hash)}](${l.url})` : NOT_RECORDED);
const tradeId = (id: string) => `\`${id.slice(0, 8)}\``;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function duration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** How a trade ended without a resolution: the reset when its event is recorded, otherwise only that it ended. */
function closedBy(t: ReportTrade): string {
  return t.resetAt ? `closed by the testnet reset on ${time(t.resetAt)}` : `the trade ended ${t.state} on ${time(t.endedAt)}`;
}

function answerCell(a: TimedAnswer, d: ReportDispute): string {
  if (a) return `${a.cashHandedOver ? "yes" : "no"}, ${time(a.answeredAt)}`;
  // Once the rule applies, the answers are final.
  return d.rule ? "no answer" : "not yet";
}

function ruleCell(d: ReportDispute): string {
  if (d.rule) return `${d.rule.rule}: ${OUTCOME[d.rule.outcome]}`;
  return d.answersDue ? `waiting for answers until ${time(d.answersDue)}` : NOT_RECORDED;
}

function outcomeCell(t: ReportTrade, d: ReportDispute): string {
  if (!d.resolvedTo) return "not resolved";
  const follows = d.followsRule ? `follows rule ${d.rule!.rule}` : `does not follow rule ${d.rule!.rule}`;
  return `${OUTCOME[d.resolvedTo]}, ${time(d.resolvedAt)}, ${txLink(t.steps.resolve)}; ${follows}`;
}

function promiseCell(t: ReportTrade, d: ReportDispute): string {
  switch (d.promise) {
    case "kept":
      return `kept: ${duration(d.tookMs!)}`;
    case "late":
      return `late: ${duration(d.tookMs!)}, due ${time(d.promisedBy)}`;
    case "open":
      return `open: due ${time(d.promisedBy)}`;
    case "missed":
      return `missed: due ${time(d.promisedBy)}${t.endedAt ? `; ${closedBy(t)}` : ""}`;
    default:
      return NOT_RECORDED;
  }
}

function signaturesCell(r: ReportResolution, threshold: number | null): string {
  const count = threshold === null ? `${r.signers.length} (threshold not read)` : `${r.signers.length} of ${threshold}`;
  return r.signers.length ? `${count}: ${r.signers.map((s) => `\`${short(s)}\``).join(", ")}` : count;
}

export function protectedReportMarkdown(r: ProtectedReport): string {
  const disputed = r.trades.filter((t) => t.dispute);
  const resolved = disputed.filter((t) => t.dispute!.resolvedTo);
  const out = [
    "# Protected trades",
    `Generated ${time(r.generatedAt)} from Pairy's database, read only. ${plural(r.trades.length, "protected trade", "protected trades")}, ${disputed.length} disputed, ${resolved.length} resolved.`,
  ];
  if (!r.trades.length) return [...out, "No protected trades."].join("\n\n") + "\n";
  out.push(
    `Trustless Work's fee address, which Pairy requires in every release and resolution it records: ${r.feeAddress ? account(r.feeAddress) : NOT_RECORDED}.`,
  );
  if (r.threshold === null) {
    out.push("The arbiter account's threshold could not be read from Horizon, so a resolution with every signature shows as collecting.");
  }

  out.push(
    "## Late promises",
    "The arbiter promises to apply the rule within 72 hours of the dispute's ledger time: a resolution is late when `resolved_at − disputed_at > 72 h`. A dispute still unresolved after 72 hours has missed the promise, and so has one the trade's end left without a resolution, such as a dispute the testnet reset closed.",
  );
  const unchecked = disputed.filter((t) => t.dispute!.promise === null);
  const late = disputed
    .filter((t) => t.dispute!.promise === "late" || t.dispute!.promise === "missed")
    .sort((a, b) => a.dispute!.disputedAt!.getTime() - b.dispute!.disputedAt!.getTime());
  out.push(
    late.length
      ? table(
          ["Trade", "Disputed (ledger time)", "Promised by", "Resolved", "Over by"],
          late.map((t) => {
            const d = t.dispute!;
            const overMs = d.tookMs! - ARBITER_PROMISE_MS;
            const over = duration(overMs);
            if (d.resolvedTo) return [tradeId(t.id), time(d.disputedAt), time(d.promisedBy), `${time(d.resolvedAt)}, ${txLink(t.steps.resolve)}`, over];
            if (t.endedAt) {
              // Closed before its deadline: missed all the same, but by no amount of time.
              const by = overMs > 0 ? over : `none: ${t.resetAt ? "closed by the testnet reset" : `the trade ended ${t.state}`} before the deadline`;
              return [tradeId(t.id), time(d.disputedAt), time(d.promisedBy), `not resolved; ${closedBy(t)}`, by];
            }
            return [tradeId(t.id), time(d.disputedAt), time(d.promisedBy), "not resolved; still open", `${over} so far`];
          }),
        )
      : unchecked.length
        ? "None among the disputes with recorded times: each was resolved within 72 hours of its ledger time, or is still inside them."
        : "None: every dispute was resolved within 72 hours of its ledger time, or is still inside them.",
  );
  if (unchecked.length) out.push(`Not checked, a time is not recorded: ${unchecked.map((t) => tradeId(t.id)).join(", ")}.`);

  out.push(
    "## Disputes",
    disputed.length
      ? table(
          [
            "Trade",
            "Escrow",
            "Opened by",
            "Disputed (ledger time)",
            "Recorded by Pairy",
            "Seller: cash handed over?",
            "Buyer: cash handed over?",
            "Rule",
            "Outcome",
            "72 h promise",
          ],
          disputed.map((t) => {
            const d = t.dispute!;
            return [
              tradeId(t.id),
              t.contractId ? `[\`${short(t.contractId)}\`](${t.viewerUrl})` : NOT_RECORDED,
              `${d.openedBy ?? NOT_RECORDED}, ${txLink(t.steps.dispute)}`,
              time(d.disputedAt),
              time(d.recordedAt),
              answerCell(d.answers.seller, d),
              answerCell(d.answers.buyer, d),
              ruleCell(d),
              outcomeCell(t, d),
              promiseCell(t, d),
            ];
          }),
        )
      : "None.",
  );

  const resolutions = r.trades
    .flatMap((t) => t.resolutions.map((x) => ({ t, x })))
    .sort((a, b) => a.x.preparedAt.getTime() - b.x.preparedAt.getTime());
  out.push(
    "## Resolutions prepared in Pairy",
    resolutions.length
      ? table(
          ["Trade", "Transaction", "Status", "Pays", "Signatures", "Prepared", "Valid until"],
          resolutions.map(({ t, x }) => [
            tradeId(t.id),
            x.url ? `[${txHash(x.txHash)}](${x.url})` : txHash(x.txHash),
            x.status,
            `${x.net} USDC to the ${x.outcome} ${account(x.recipient)} (${trimAmount(x.amount)} USDC less Trustless Work's 0.3%), rule ${x.rule}`,
            signaturesCell(x, r.threshold),
            `${time(x.preparedAt)} by \`${short(x.preparedBy)}\``,
            time(x.validUntil),
          ]),
        )
      : "None.",
  );

  out.push(
    "## Every protected trade",
    table(
      ["Trade", "Opened", "State", "USDC", "Seller", "Buyer", "Escrow", "Create", "Fund", "Release", "Dispute", "Resolve"],
      r.trades.map((t) => [
        tradeId(t.id),
        time(t.openedAt),
        t.state,
        trimAmount(t.amount),
        account(t.seller),
        account(t.buyer),
        t.contractId ? `[\`${short(t.contractId)}\`](${t.viewerUrl})` : NOT_RECORDED,
        txLink(t.steps.create),
        txLink(t.steps.fund),
        txLink(t.steps.release),
        txLink(t.steps.dispute),
        txLink(t.steps.resolve),
      ]),
    ),
  );
  return out.join("\n\n") + "\n";
}
