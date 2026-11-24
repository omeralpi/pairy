'use client';

import Link from "next/link";
import { useEffect, useState } from "react";

import { answersLine } from "@/components/arbiter/arbiter-list";
import {
  NOT_ACCEPTED,
  checkResolution,
  dropsHeld,
  failureSentence,
  handoffSentence,
  heldResolution,
  signResolution,
  signerProblem,
  validity,
  type Dispute,
  type Prepared,
} from "@/components/arbiter/resolve-flow";
import { readEscrowOnChain } from "@/components/escrow/escrow-steps";
import { friendlyError } from "@/components/friendly-error";
import { shortAddress, trimAmount } from "@/components/listing/format";
import { shortWhen } from "@/components/trade/format";
import { StepFeedback } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { useNow } from "@/components/trade/use-now";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ARBITER_ACCOUNT, USDC_SAC } from "@/lib/escrow/config";
import { netAfterFee } from "@/lib/escrow/fee";
import { explorerAccountUrl } from "@/lib/stellar/horizon";
import { fromStroops } from "@/lib/trade/amount";
import { PENDING_TX_MAX_AGE_MS, clearPendingTx, readPendingTx, stepRunning } from "@/lib/trade/pending-tx";
import { useWallet } from "@/lib/wallet/use-wallet";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";
const STEP_LABEL = { create: "Create", fund: "Fund", dispute: "Dispute", resolve: "Resolve" } as const;

/**
 * One dispute as the arbiter sees it (D2 §7.4): the escrow read fresh from the
 * chain, both addresses, every on-chain step, both answers and notes, and the
 * one resolution the published rule gives, prepared, signed in Varial and sent
 * from the last signer's browser. Pairy's server signs and sends nothing.
 */
export function DisputePanel({ tradeId, me }: { tradeId: string; me: string }) {
  const utils = api.useUtils();
  const now = useNow();
  const { wallet, ready } = useWallet();
  const dispute = api.arbiter.byId.useQuery({ tradeId }, { refetchInterval: 10_000, retry: false });
  // FIXES F-03: one resolution is signed at a time across all trades; the list says whose.
  const others = api.arbiter.list.useQuery(undefined, { refetchInterval: 15_000 });
  const prepareResolution = api.arbiter.prepareResolution.useMutation();
  const addSignature = api.arbiter.addSignature.useMutation();
  const { mutateAsync: recordResolution } = api.arbiter.recordResolution.useMutation();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // This browser handed the merged resolve to Horizon (FIXES F-03: a refusal then means the network did not accept it).
  const [sent, setSent] = useState(false);
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordResolution({ tradeId, txHash });
      } catch (e) {
        // The traders' sync may have recorded this very resolve first (WP-35's pattern).
        const now = await utils.arbiter.byId.fetch({ tradeId }, { staleTime: 0 });
        if (!now.steps.some((s) => s.step === "resolve" && s.txHash === txHash)) throw e;
      }
      await utils.arbiter.invalidate();
    },
    { tradeId, kind: "resolve" },
  );

  const d = dispute.data;
  const landed = d?.steps.find((s) => s.step === "resolve") ?? null;
  // A resolve this browser sent (pending `resolve`) that Pairy has not recorded yet: report it, as useTradeSync does for traders.
  const pending = readPendingTx(tradeId);
  const kept = pending?.kind === "resolve" ? pending : null;
  const keptHash = kept?.hash ?? null;
  const keptAt = kept?.savedAt ?? null;
  const state = d?.state ?? null;
  const landedHash = landed?.txHash ?? null;
  // Every refetch of the dispute is another try, as useTradeSync's tick is for a trader.
  const fetchedAt = dispute.dataUpdatedAt;
  useEffect(() => {
    if (!keptHash || keptAt === null || !state) return;
    // The step on this page is sending or recording it: it reports it itself (WP-35, one record).
    if (stepRunning(tradeId)) return;
    if (state !== "funded" || landedHash) {
      clearPendingTx(tradeId);
      return;
    }
    recordResolution({ tradeId, txHash: keptHash })
      .then(() => {
        clearPendingTx(tradeId);
        return utils.arbiter.invalidate();
      })
      .catch(() => {
        // Not on the ledger (yet): a reload reports it again; the traders' sync records a landed resolve too.
        if (Date.now() - keptAt > PENDING_TX_MAX_AGE_MS) clearPendingTx(tradeId);
      });
  }, [keptHash, keptAt, state, landedHash, fetchedAt, tradeId, recordResolution, utils]);

  if (dispute.isLoading) return <p className="text-sm text-slate">Loading…</p>;
  if (dispute.error || !d) {
    return (
      <p className="text-sm text-danger" role="alert">
        {dispute.error ? friendlyError(dispute.error) : "No dispute for the arbiter on this trade."}
      </p>
    );
  }

  const held = heldResolution(prepared, d.resolution);
  const other = others.data?.find((x) => x.tradeId !== tradeId && x.resolution && x.resolution.expiresAt.getTime() > now)?.tradeId ?? null;
  const busy = working || step.busy;

  /** `reopen`: the next signer opening the trade's open resolution, which the server returns unless it can no longer land. */
  async function prepare(reopen: boolean) {
    setFailure(null);
    setNotice(null);
    setSent(false);
    setWorking(true);
    const openId = d?.resolution?.id ?? null;
    try {
      const next = await prepareResolution.mutateAsync({ tradeId });
      setPrepared(next);
      if (reopen && openId && next.resolutionId !== openId) {
        setNotice("The earlier prepared transaction could no longer land (the arbiter account moved on), so this is a new one: every signer signs it.");
      }
    } catch (e) {
      setFailure(failureSentence(e));
    } finally {
      setWorking(false);
    }
    // The list and the dispute refetch in the background; Sign is not held for them.
    void utils.arbiter.invalidate();
  }

  async function sign() {
    if (!held || !wallet || !d) return;
    setFailure(null);
    setNotice(null);
    setWorking(true);
    try {
      const added = await signResolution({
        prepared: held,
        dispute: d,
        wallet,
        readEscrow: readEscrowOnChain,
        addSignature: (input) => addSignature.mutateAsync(input),
        run: step.run,
        onSend: () => setSent(true),
      });
      setPrepared({ ...held, signers: added.signers });
      if (added.signerCount < added.threshold) setNotice(handoffSentence(added));
    } catch (e) {
      const sentence = failureSentence(e, held.expiresAt);
      setFailure(sentence);
      if (dropsHeld(sentence)) {
        setPrepared(null);
        // The server closed it: the page stops offering it before the refetch below says so.
        utils.arbiter.byId.setData({ tradeId }, (old) => (old?.resolution?.id === held.resolutionId ? { ...old, resolution: null } : old));
      }
    } finally {
      setWorking(false);
    }
    void utils.arbiter.invalidate();
  }

  const outcomeOf = (state: string) => (state === "resolved_buyer" ? "buyer" : "seller");

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <p className="eyebrow">Dispute · {d.state === "funded" ? "open" : "settled"}</p>
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          <span className="font-mono font-medium">{trimAmount(d.amount)} USDC</span> <em className="font-serif font-normal">in escrow.</em>
        </h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-slate">Seller</dt>
          <dd>
            <Account publicKey={d.seller} />
          </dd>
          <dt className="text-slate">Buyer</dt>
          <dd>
            <Account publicKey={d.buyer} />
          </dd>
          <dt className="text-slate">Escrow</dt>
          <dd className="min-w-0">
            <a href={d.viewerUrl} target="_blank" rel="noreferrer" className={`font-mono text-xs [overflow-wrap:anywhere] ${linkClass}`}>
              {d.contractId}
            </a>
          </dd>
        </dl>
        <p className="text-sm text-slate">
          Dispute opened by the {d.disputeOpenedBy ?? "trader"}, {shortWhen(d.disputedAt!)}; shown in the trade room {shortWhen(d.disputeRecordedAt!)}.
        </p>
        {d.state === "funded" &&
          (d.overdue ? (
            <p className="text-sm font-medium text-danger">Overdue: the arbiter promised a resolution by {shortWhen(d.promiseDeadline)}.</p>
          ) : (
            <p className="text-sm text-slate">The arbiter signs by {shortWhen(d.promiseDeadline)}.</p>
          ))}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">The escrow on chain</h2>
        {d.escrow ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Term label="amount" value={`${fromStroops(d.escrow.terms.amountStroops)} USDC`} />
            <Term label="holds" value={`${fromStroops(d.escrow.status.balanceStroops)} USDC · ${statusWords(d.escrow.status)}`} />
            <Term label="receiver" address={d.escrow.terms.receiver} who={whoIs(d.escrow.terms.receiver, d)} />
            <Term label="release signer" address={d.escrow.terms.releaseSigners[0] ?? ""} who={whoIs(d.escrow.terms.releaseSigners[0] ?? "", d)} />
            <Term label="dispute resolver" address={d.escrow.terms.disputeResolvers[0] ?? ""} who={whoIs(d.escrow.terms.disputeResolvers[0] ?? "", d)} />
            <Term label="token" value={d.escrow.terms.tokenContract === USDC_SAC ? "USDC" : d.escrow.terms.tokenContract} />
            <Term label="platform fee" value={`${d.escrow.terms.platformFeePercent}%`} />
          </dl>
        ) : (
          <p className="text-sm text-slate">Couldn&apos;t read the escrow from Stellar testnet just now. Its terms and balance show once it answers.</p>
        )}
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {d.steps.map((s) => (
            <li key={s.step}>
              <a href={s.url} target="_blank" rel="noreferrer" className={`font-mono ${linkClass}`}>
                {STEP_LABEL[s.step]} receipt ↗
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Was the cash handed over in full?</h2>
        <p className="text-sm text-ink">{answersLine(d.answers)}</p>
        {d.notes.seller && <Quote who="Seller" note={d.notes.seller} />}
        {d.notes.buyer && <Quote who="Buyer" note={d.notes.buyer} />}
      </section>

      <section className="space-y-4">
        <h2 className="eyebrow">Resolution</h2>
        {d.state !== "funded" ? (
          <p className="text-sm text-ink">
            Resolved: all to the {outcomeOf(d.state)}, less Trustless Work&apos;s 0.3%.{" "}
            {landed && (
              <a href={landed.url} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
                Receipt ↗
              </a>
            )}
          </p>
        ) : !d.ready ? (
          <p className="text-sm text-ink">Waiting for answers until {shortWhen(d.answerDeadline)}.</p>
        ) : (
          <ResolutionSection
            dispute={d}
            me={me}
            now={now}
            held={held}
            other={other}
            signerProblem={signerProblem(wallet, ready, me)}
            busy={busy}
            recovering={!!kept && !landed}
            refused={sent && !!step.error && !step.unreported && !kept}
            failure={failure}
            notice={notice}
            step={step}
            onPrepare={prepare}
            onSign={sign}
          />
        )}
      </section>
    </div>
  );
}

/**
 * The resolution part of a dispute the rule can decide (D2 §7.4, FIXES F-03):
 * the rule, the payee and amount as the server reads them, and what can be
 * done now. In order: a resolve this browser sent and is recording; one the
 * network refused; the resolution this page holds; another trade's being
 * signed; this trade's open one, expired, fully signed, signed by me, or
 * waiting for me; else Prepare.
 */
export function ResolutionSection(p: {
  dispute: Dispute;
  me: string;
  now: number;
  held: Prepared | null;
  /** The trade whose resolution is being signed, when it is not this one. */
  other: string | null;
  signerProblem: string | null;
  busy: boolean;
  recovering: boolean;
  refused: boolean;
  failure: string | null;
  notice: string | null;
  step: ReturnType<typeof useChainStep>;
  onPrepare: (reopen: boolean) => void;
  onSign: () => void;
}) {
  const d = p.dispute;
  const open = d.resolution;
  const openValidity = open ? validity(open.expiresAt, p.now) : null;
  const payee = d.outcome === "buyer" ? d.buyer : d.seller;
  const balance = d.escrow?.status.balanceStroops ?? null;
  const view = p.recovering
    ? "recovering"
    : p.refused
      ? "refused"
      : p.held
        ? "card"
        : p.other
          ? "other"
          : !open || !openValidity
            ? "prepare"
            : openValidity.expired
              ? "expired"
              : open.signers.length >= open.threshold
                ? "signed"
                : open.signers.includes(p.me)
                  ? "waiting"
                  : "open";
  const prepareButton = (
    <Button variant="beacon" size="lg" className="h-auto min-h-14 w-full whitespace-normal py-3" disabled={p.busy} onClick={() => p.onPrepare(false)}>
      {p.busy ? "Preparing…" : `Prepare the resolution (all to the ${d.outcome})`}
    </Button>
  );

  return (
    <>
      <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">{d.ruleSentence}</p>
      <p className="text-sm text-ink">
        The rule gives: all to the {d.outcome} (rule {d.rule}).
      </p>
      <p className="text-sm text-slate [overflow-wrap:anywhere]">
        Payee: the {d.outcome}, {shortAddress(payee)}.
        {balance !== null && (
          <>
            {" "}
            Amount: {fromStroops(balance)} USDC, all the escrow holds; the {d.outcome} receives {fromStroops(netAfterFee(balance))} USDC after Trustless
            Work&apos;s 0.3%.
          </>
        )}
      </p>
      {view === "recovering" ? (
        <p className="text-sm text-slate">A resolution was sent from this browser. Recording it once Stellar testnet shows it…</p>
      ) : view === "refused" ? (
        <>
          <p className="text-sm text-ink">{NOT_ACCEPTED}</p>
          {prepareButton}
        </>
      ) : view === "card" && p.held ? (
        <ResolutionCard
          prepared={p.held}
          check={checkResolution(p.held, d, new Date(p.now))}
          me={p.me}
          signerProblem={p.signerProblem}
          now={p.now}
          busy={p.busy}
          onSign={p.onSign}
          notice={p.notice}
        />
      ) : view === "other" && p.other ? (
        <p className="text-sm text-ink">
          Another resolution is being signed (trade{" "}
          <Link href={`/arbiter/${p.other}`} className={`font-mono ${linkClass}`}>
            {p.other.slice(0, 8)}
          </Link>
          ). Finish or let it expire first.
        </p>
      ) : view === "expired" && open ? (
        <>
          <p className="text-sm text-ink">This prepared transaction expired at {shortWhen(open.expiresAt)}. Prepare again.</p>
          {prepareButton}
        </>
      ) : view === "signed" && open ? (
        <>
          <p className="text-sm text-ink">
            All {open.threshold} signatures are in. The last signer&apos;s browser sends it, and this page updates once it lands. If it never does, prepare
            again.
          </p>
          {prepareButton}
        </>
      ) : view === "waiting" ? (
        <p className="text-sm text-ink">You signed. Waiting for the other signer; this page updates when the resolution lands.</p>
      ) : view === "open" && open && openValidity ? (
        <>
          <div className="space-y-2">
            <p className="text-sm text-ink">
              A resolution is prepared: {open.signers.length} of {open.threshold} signed, valid until {openValidity.until}.
            </p>
            <p className="text-xs text-slate">Signed by {open.signers.map(shortAddress).join(", ") || "nobody yet"}</p>
            {p.signerProblem && <p className="text-sm text-slate">{p.signerProblem}</p>}
          </div>
          <Button variant="beacon" size="lg" className="h-auto min-h-14 w-full whitespace-normal py-3" disabled={p.busy} onClick={() => p.onPrepare(true)}>
            {p.busy ? "Opening…" : "Open the prepared resolution"}
          </Button>
        </>
      ) : (
        prepareButton
      )}
      {p.failure && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger [overflow-wrap:anywhere]">
          {p.failure}
        </p>
      )}
      <StepFeedback step={p.step} />
    </>
  );
}

/**
 * One prepared resolution: its hash, what signing it does, how long it is
 * valid (O-17: "valid until hh:mm"), who signed, and Sign. The button is
 * disabled unless this browser's own check passed and its wallet is the
 * signed-in signer's Varial.
 */
export function ResolutionCard(p: {
  prepared: Pick<Prepared, "txHash" | "expiresAt" | "threshold" | "signers">;
  check: { problems: string[]; summary: string };
  me: string;
  signerProblem: string | null;
  now: number;
  busy: boolean;
  onSign: () => void;
  notice: string | null;
}) {
  const v = validity(p.prepared.expiresAt, p.now);
  const signed = p.prepared.signers.includes(p.me);
  const refused = p.check.problems.length > 0;
  return (
    <div className="space-y-4 rounded-xl border border-line p-5">
      <div className="space-y-1">
        <p className="eyebrow">Prepared resolution</p>
        <p className="break-all font-mono text-xs text-slate">{p.prepared.txHash}</p>
      </div>
      {v.expired ? (
        <p className="text-sm text-ink">This prepared transaction expired at {shortWhen(p.prepared.expiresAt)}. Prepare again.</p>
      ) : (
        <>
          {refused ? (
            <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
              This browser won&apos;t sign it: {p.check.problems.join(" ")}
            </p>
          ) : (
            <p className="text-sm text-ink">
              What you will sign: <span className="font-medium">{p.check.summary}</span>
            </p>
          )}
          <p className="text-sm text-slate">
            Valid until {v.until}; signatures are taken until {v.signUntil} ({v.left}), the last ten minutes are for sending. When
            it runs out nothing has been sent and no fee is paid: prepare again.
          </p>
          <p className="text-sm text-ink">
            {p.prepared.signers.length} of {p.prepared.threshold} signed
            {p.prepared.signers.length > 0 && (
              <span className="text-slate">
                {" "}
                · Signed by {p.prepared.signers.map((s) => `${shortAddress(s)}${s === p.me ? " (you)" : ""}`).join(", ")}
              </span>
            )}
          </p>
          {p.notice && <p className="text-sm font-medium text-ink">{p.notice}</p>}
          {!signed && (
            <div className="space-y-2">
              <Button variant="beacon" size="lg" className="h-auto min-h-14 w-full whitespace-normal py-3" disabled={p.busy || refused || !!p.signerProblem} onClick={p.onSign}>
                {p.busy ? "Signing…" : `Sign as ${shortAddress(p.me)}`}
              </Button>
              {p.signerProblem && <p className="text-sm text-slate">{p.signerProblem}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Account({ publicKey }: { publicKey: string }) {
  return (
    <a href={explorerAccountUrl(publicKey)} target="_blank" rel="noreferrer" title={publicKey} className={`font-mono ${linkClass}`}>
      {shortAddress(publicKey)}
    </a>
  );
}

function Term({ label, value, address, who }: { label: string; value?: string; address?: string; who?: string | null }) {
  return (
    <>
      <dt className="text-slate">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {address !== undefined ? (
          <span title={address} className="font-mono">
            {address ? shortAddress(address) : "nobody"}
          </span>
        ) : (
          value
        )}
        {who && <span className="text-slate"> · {who}</span>}
      </dd>
    </>
  );
}

function Quote({ who, note }: { who: string; note: string }) {
  return (
    <blockquote className="border-l-2 border-line pl-4 text-sm text-ink [overflow-wrap:anywhere]">
      <span className="text-slate">{who}: </span>
      {note}
    </blockquote>
  );
}

/** Which role an address on the escrow holds in this trade, for the terms block. */
function whoIs(address: string, d: Pick<Dispute, "seller" | "buyer">): string | null {
  if (address === d.seller) return "the seller";
  if (address === d.buyer) return "the buyer";
  if (address === ARBITER_ACCOUNT) return "the arbiter";
  return address ? "not a party to this trade" : null;
}

function statusWords(s: { disputed: boolean; released: boolean; resolved: boolean }): string {
  return s.resolved ? "resolved" : s.released ? "released" : s.disputed ? "disputed" : "not disputed";
}
