// The only code that talks to Trustless Work (DECISIONS 13): plain fetch and
// zod, no SDK. Trustless Work only prepares unsigned transactions; the
// trader's own wallet signs them and the browser sends them to Horizon.
//
// Pairy asks only for the calls in TW_ENDPOINTS, and
// tests/ci/tw-endpoint-allowlist pins that list. Every request is checked
// before it leaves and every answer before it is used, so a change on
// Trustless Work's side (the V2 API is in beta) fails loudly here instead of
// reaching a signer.

import { StrKey } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { TW_API_BASE } from "@/lib/escrow/config";
import { fromUnits } from "@/lib/trade/amount";

export type TwEndpoint = "deploy" | "fund" | "approveAndRelease" | "dispute" | "resolve" | "submit" | "read";

export const TW_ENDPOINTS: Readonly<Record<TwEndpoint, { method: "GET" | "POST"; path: string }>> = {
  deploy: { method: "POST", path: "/escrow/single-release/v2/deploy" },
  fund: { method: "POST", path: "/escrow/single-release/v2/fund" },
  approveAndRelease: { method: "POST", path: "/escrow/single-release/v2/approve-and-release-milestones" },
  dispute: { method: "POST", path: "/escrow/single-release/v2/dispute" },
  resolve: { method: "POST", path: "/escrow/single-release/v2/resolve-dispute" },
  // Allowlisted but unused: the browser sends every signed transaction to Horizon itself (PLAN I3).
  submit: { method: "POST", path: "/stellar/send-transaction" },
  // Scripts and diagnostics only. Its status lags the chain, so never use it for a trade's state.
  read: { method: "GET", path: "/escrows/{contractId}" },
};

const account = z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "Not a Stellar account address");
const contract = z.string().refine((s) => StrKey.isValidContract(s), "Not a Stellar contract address");
/** A decimal JSON number, not stroops: Trustless Work converts it (see twAmount). */
const amount = z
  .number()
  .positive()
  .finite()
  .refine((n) => Number(n.toFixed(7)) === n, "At most 7 decimal places");

/** Request bodies, per Trustless Work's V2 DTOs. Closed objects: nothing extra is ever sent. */
const INPUT = {
  deploy: z
    .object({
      signer: account,
      engagementId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      roles: z
        .object({
          approvers: z.array(account).min(1),
          serviceProviders: z.array(account).min(1),
          releaseSigners: z.array(account).min(1),
          receiver: account,
          platform: account,
          disputeResolvers: z.array(account).min(1),
          admin: account,
        })
        .strict(),
      amount,
      platformFee: z.number().min(0).max(100), // a percent
      trustline: z.object({ contractId: contract }).strict(),
      milestones: z.array(z.object({ description: z.string().min(1) }).strict()).min(1),
    })
    .strict(),
  fund: z.object({ contractId: contract, signer: account, amount }).strict(),
  approveAndRelease: z
    .object({ contractId: contract, signer: account, milestoneIndexes: z.array(z.number().int().min(0)).min(1) })
    .strict(),
  dispute: z.object({ contractId: contract, signer: account, reason: z.string().min(1) }).strict(),
  resolve: z
    .object({
      contractId: contract,
      disputeResolver: account,
      distributions: z.array(z.object({ address: account, amount }).strict()).min(1),
    })
    .strict(),
  submit: z.object({ signedXdr: z.string().min(1) }).strict(),
  read: z.object({ contractId: contract }).strict(),
} satisfies Record<TwEndpoint, z.ZodTypeAny>;

const txHash = z.string().regex(/^[0-9a-f]{64}$/);
/** What every prepare call returns: the unsigned transaction for the caller's wallet. */
const unsignedTx = z.object({ unsignedXdr: z.string().min(1), txHash, contractId: contract.optional() });

/** The fields Pairy reads from each answer. Unknown extra fields are dropped. */
const OUTPUT = {
  // The new escrow's address arrives before anything is signed; WP-10 re-derives it from the XDR.
  deploy: unsignedTx.extend({ contractId: contract }),
  fund: unsignedTx,
  approveAndRelease: unsignedTx,
  dispute: unsignedTx,
  resolve: unsignedTx,
  submit: z.object({ txHash, ledger: z.number().int() }),
  read: z.object({
    escrow: z.object({ contractId: contract, type: z.string(), status: z.string(), amount: z.string(), balance: z.string() }),
  }),
} satisfies Record<TwEndpoint, z.ZodTypeAny>;

export type TwInput = { [E in TwEndpoint]: z.input<(typeof INPUT)[E]> };
export type TwOutput = { [E in TwEndpoint]: z.output<(typeof OUTPUT)[E]> };

/** Trustless Work's RFC 7807 error body; only the two fields Pairy reads. */
const problemDocument = z.object({ code: z.string().optional(), detail: z.string().optional() });

const RETRY = "Trustless Work isn't answering right now. Nothing was signed; try again in a minute.";
const UNEXPECTED = "Trustless Work answered in an unexpected shape, so Pairy stopped. Nothing was signed.";

/** Trustless Work refused a call, did not answer, or answered in a shape Pairy does not know. Nothing was signed. */
export class TwApiError extends Error {
  readonly endpoint: TwEndpoint;
  /** The HTTP status; 0 when no answer arrived (timeout or network). */
  readonly status: number;
  /** From Trustless Work's error body, when it was a problem document. */
  readonly code: string | undefined;
  readonly detail: string | undefined;

  constructor(
    endpoint: TwEndpoint,
    status: number,
    message: string,
    problem: { code?: string; detail?: string } = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.endpoint = endpoint;
    this.status = status;
    this.code = problem.code;
    this.detail = problem.detail;
  }
}

/** Stroops → the decimal number Trustless Work takes. Throws when a double cannot carry the amount exactly. */
export function twAmount(stroops: bigint): number {
  const s = fromUnits(stroops, 7);
  if (Number(s).toFixed(7) !== s) throw new Error(`${s} cannot be sent to Trustless Work exactly`);
  return Number(s);
}

/** One line per call. Never headers or bodies: the key is in one, trade data in the other. */
function log(ep: TwEndpoint, status: number, started: number, ctx: { tradeId?: string }) {
  console.log(JSON.stringify({ evt: "tw", ep, status, ms: Date.now() - started, tradeId: ctx.tradeId }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function apiKey(): string | undefined {
  return process.env.TRUSTLESS_WORK_API_KEY?.trim() || undefined;
}

/** Whether this server has a Trustless Work key; the key itself never leaves this file. */
export function twConfigured(): boolean {
  return apiKey() !== undefined;
}

/** The only function that talks to Trustless Work: 15 s timeout, x-api-key, every answer zod-checked, one log line. */
export async function twCall<E extends TwEndpoint>(
  ep: E,
  input: TwInput[E],
  ctx: { tradeId?: string },
): Promise<TwOutput[E]> {
  const key = apiKey();
  // Not INTERNAL_SERVER_ERROR: production hides those messages, and this one is for the trader.
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Protected trades are not configured" });
  // A bad body is Pairy's own bug: refused here, before anything is sent.
  const body = INPUT[ep].parse(input);
  const get = TW_ENDPOINTS[ep].method === "GET";

  const started = Date.now();
  let status = 0;
  let text: string;
  try {
    // Only `read` has a placeholder; its contract address was validated above.
    const res = await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path.replace("{contractId}", () => (body as TwInput["read"]).contractId), {
      method: TW_ENDPOINTS[ep].method,
      headers: get ? { "x-api-key": key } : { "x-api-key": key, "content-type": "application/json" },
      body: get ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      // Next caches server-side GETs by default; an escrow read must be fresh.
      cache: "no-store",
      // A redirect would carry x-api-key to wherever it points: refuse it.
      redirect: "error",
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    log(ep, status, started, ctx);
    throw new TwApiError(ep, status, RETRY, {}, e);
  }
  log(ep, status, started, ctx);

  const json = parseJson(text);
  if (status < 200 || status > 299) {
    const parsed = problemDocument.safeParse(json);
    const problem = parsed.success ? parsed.data : {};
    const message = status >= 500 ? RETRY : (problem.detail ?? `Trustless Work refused the request (HTTP ${status}).`);
    throw new TwApiError(ep, status, message, problem);
  }
  const out = OUTPUT[ep].safeParse(json);
  if (!out.success) throw new TwApiError(ep, status, UNEXPECTED, {}, out.error);
  return out.data as TwOutput[E];
}
