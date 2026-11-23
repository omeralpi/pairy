// The check every escrow transaction passes before anyone is asked to sign it
// (DECISIONS 7, PLAN I7): on the server right after Trustless Work prepares
// it, and again in the browser before the wallet opens. Trustless Work only
// builds the transaction; this is what makes "you sign what the screen says"
// true. Pure functions over public data, so the browser, the server and the
// evidence scripts run the same code.

import {
  Address,
  FeeBumpTransaction,
  StrKey,
  TransactionBuilder,
  hash,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { fromStroops } from "@/lib/trade/amount";

import { DISPUTE_REASON, ESCROW_XLM_NEED, TW_ESCROW_WASM_HASH, TW_FACTORY_CONTRACT_ID, TW_FEE_ADDRESS, USDC_SAC } from "./config";
import { netAfterFee } from "./fee";

export type EscrowCall = "deploy" | "fund" | "release" | "dispute" | "resolve";

/** What an escrow promises. Moves to lib/escrow/terms.ts with WP-14's expectedTerms and checkEscrowTerms. */
export type EscrowTerms = {
  admin: string;
  platform: string;
  receiver: string;
  approvers: string[];
  releaseSigners: string[];
  disputeResolvers: string[];
  serviceProviders: string[];
  amountStroops: bigint;
  platformFeePercent: number;
  tokenContract: string;
  milestones: { description: string }[];
};

/** One authorized contract call, and the calls it authorizes in turn. */
export type AuthCall = { contractId: string; fn: string; args: unknown[]; subInvocations: AuthCall[] };

export type DecodedCall = {
  /** "testnet" when the hash Trustless Work sent is this transaction's hash on testnet. */
  network: "testnet" | "other";
  /** The transaction's hash on testnet, hex: what each signer signs. */
  hash: string;
  source: string;
  /** The most the source can be charged, in stroops: inclusion and Soroban resource fees together. */
  fee: bigint;
  opCount: number;
  /** The first operation's type, and its own source account when it has one. */
  opType: string;
  opSource: string | null;
  /** The contract call the first operation makes; empty when it makes none. */
  contractId: string;
  fn: string;
  /** The call's arguments as plain values (scValToNative): addresses as strings, amounts as bigints. */
  args: unknown[];
  authRoots: (AuthCall & { credentials: "source" | "address"; address?: string })[];
  timeBounds: { minTime: number; maxTime: number } | null;
};

export type CallExpectation =
  /** contractId: the new escrow's address as Trustless Work returned it. */
  | { kind: "deploy"; admin: string; contractId: string; terms: EscrowTerms }
  | { kind: "fund"; contractId: string; seller: string; amountStroops: bigint; terms: EscrowTerms }
  | { kind: "release"; contractId: string; seller: string }
  | { kind: "dispute"; contractId: string; signer: string }
  /** timePolicy (O-17): "server-original" (the default) for Trustless Work's resolve as returned; "browser-rebuilt" for it re-timed by rebuildMaxTime. */
  | { kind: "resolve"; contractId: string; resolver: string; recipient: string; amountStroops: bigint; timePolicy?: "server-original" | "browser-rebuilt" };

const FN: Record<EscrowCall, string> = {
  deploy: "tw_new_single_release_escrow",
  fund: "fund_escrow",
  release: "approve_and_release_milestones",
  dispute: "dispute_escrow",
  resolve: "resolve_dispute",
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function authCall(inv: xdr.SorobanAuthorizedInvocation): AuthCall {
  const f = inv.function;
  const subInvocations = inv.subInvocations.map(authCall);
  if (f.type !== "sorobanAuthorizedFunctionTypeContractFn") return { contractId: "", fn: f.type, args: [], subInvocations };
  return {
    contractId: Address.fromScAddress(f.contractFn.contractAddress).toString(),
    fn: String(f.contractFn.functionName),
    args: f.contractFn.args.map((a) => scValToNative(a)),
    subInvocations,
  };
}

function authRoot(entry: xdr.SorobanAuthorizationEntry): DecodedCall["authRoots"][number] {
  const c = entry.credentials;
  const root = authCall(entry.rootInvocation);
  if (c.type === "sorobanCredentialsSourceAccount") return { ...root, credentials: "source" };
  const credentials =
    c.type === "sorobanCredentialsAddress" ? c.address : c.type === "sorobanCredentialsAddressV2" ? c.addressV2 : c.addressWithDelegates.addressCredentials;
  return { ...root, credentials: "address", address: Address.fromScAddress(credentials.address).toString() };
}

/** Reads a transaction Trustless Work prepared. Throws on XDR that is not a plain transaction. */
export function decodeEscrowCall(prepared: { unsignedXdr: string; txHash: string }): DecodedCall {
  const tx = TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE);
  if (tx instanceof FeeBumpTransaction) throw new Error("This is a fee-bump transaction, not an escrow call.");
  const op = tx.operations[0];
  const invoke = op?.type === "invokeHostFunction" ? op : null;
  const call = invoke?.func.type === "hostFunctionTypeInvokeContract" ? invoke.func.invokeContract : null;
  const txHash = hex(tx.hash());
  return {
    network: txHash === prepared.txHash ? "testnet" : "other",
    hash: txHash,
    source: tx.source,
    fee: BigInt(tx.fee),
    opCount: tx.operations.length,
    opType: op?.type ?? "none",
    opSource: op?.source ?? null,
    contractId: call ? Address.fromScAddress(call.contractAddress).toString() : "",
    fn: call ? String(call.functionName) : "",
    args: call ? call.args.map((a) => scValToNative(a)) : [],
    authRoots: (invoke?.auth ?? []).map(authRoot),
    timeBounds: tx.timeBounds ? { minTime: Number(tx.timeBounds.minTime), maxTime: Number(tx.timeBounds.maxTime) } : null,
  };
}

/**
 * The address the factory gives the escrow a deploy creates: a function of the
 * factory and the deploy's salt argument, so it is known before anything is
 * signed (FIXES F-02). Throws on a call that is not a deploy.
 */
export function deriveEscrowId(d: DecodedCall): string {
  const salt = d.args[2];
  if (d.fn !== FN.deploy || !(salt instanceof Uint8Array) || salt.length !== 32) throw new Error("Not an escrow deploy.");
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(NETWORK_PASSPHRASE),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(d.contractId).toScAddress(), salt }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

const ARG_COUNT: Record<EscrowCall, number> = { deploy: 6, fund: 3, release: 3, dispute: 2, resolve: 3 };

/**
 * Trustless Work prepares every call valid for 300 s (S-14); the minute on top
 * allows for a clock that runs a little behind. That is the rule for every call
 * as Trustless Work returns it ("server-original").
 *
 * Two arbiter signers on two computers need longer, so Pairy re-times the
 * resolve before anyone signs (O-17, rebuildMaxTime). The re-timed resolve
 * ("browser-rebuilt") must expire between 10 minutes and 24 hours from now.
 */
const TW_VALIDITY_S = 300;
const CLOCK_SLACK_S = 60;
const REBUILT_MIN_S = 10 * 60;
const REBUILT_MAX_S = 24 * 3600;

/** A stable text form of decoded values, for exact comparison (bigints and bytes included). */
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? `0x${hex(x)}` : x));

function show(v: unknown): string {
  if (typeof v === "bigint") return `${fromStroops(v)} USDC`;
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.length ? v.map((x: unknown) => (x !== null && typeof x === "object" ? show(Object.values(x)[0]) : show(x))).join(", ") : "none";
  if (v !== null && typeof v === "object") return "a structure";
  return v === undefined ? "missing" : String(v);
}

const TERM_LABEL: Record<keyof EscrowTerms, string> = {
  admin: "admin",
  platform: "platform",
  receiver: "receiver",
  approvers: "approvers",
  releaseSigners: "release signers",
  disputeResolvers: "dispute resolvers",
  serviceProviders: "service providers",
  amountStroops: "amount",
  platformFeePercent: "platform fee",
  tokenContract: "token",
  milestones: "milestones",
};

/**
 * An escrow as the contract stores it (the deploy's init argument, fund's
 * expected_escrow): its terms against Pairy's, and whether it is untouched.
 */
function escrowProblems(found: unknown, expected: EscrowTerms): string[] {
  // The contract's struct, decoded; every field read here is compared below.
  const s: any = found ?? {};
  const roles = s.roles ?? {};
  const terms: Record<keyof EscrowTerms, unknown> = {
    admin: roles.admin,
    platform: roles.platform,
    receiver: roles.receiver,
    approvers: roles.approvers,
    releaseSigners: roles.release_signers,
    disputeResolvers: roles.dispute_resolvers,
    serviceProviders: roles.service_providers,
    amountStroops: s.amount,
    platformFeePercent: s.platform_fee,
    tokenContract: s.trustline?.address,
    milestones: Array.isArray(s.milestones) ? s.milestones.map((m: { description?: unknown }) => ({ description: m?.description })) : s.milestones,
  };
  const problems = (Object.keys(TERM_LABEL) as (keyof EscrowTerms)[])
    .filter((k) => canon(terms[k]) !== canon(expected[k]))
    .map((k) => `The escrow's ${TERM_LABEL[k]} ${Array.isArray(expected[k]) ? "are" : "is"} ${show(terms[k])}, not ${show(expected[k])}.`);
  if (s.released !== false) problems.push("The escrow is already marked released.");
  if (s.dispute?.is_disputed !== false || s.dispute?.resolved !== false) problems.push("The escrow is already in a dispute.");
  return problems;
}

/** The calls the root call may authorize in turn: the deploy's initialisation, the fund's USDC transfer, nothing else. */
function expectedSubInvocations(d: DecodedCall, e: CallExpectation): AuthCall[] {
  if (e.kind === "deploy") {
    return [{ contractId: e.contractId, fn: "initialize_escrow", args: Array.isArray(d.args[4]) ? d.args[4] : [], subInvocations: [] }];
  }
  if (e.kind === "fund") return [{ contractId: USDC_SAC, fn: "transfer", args: [e.seller, e.contractId, e.amountStroops], subInvocations: [] }];
  return [];
}

/** Problems in plain words; [] = safe to sign. `now` is checked against the transaction's time bounds. */
export function validateEscrowCall(d: DecodedCall, e: CallExpectation, now = new Date()): string[] {
  const problems: string[] = [];
  const signer = e.kind === "deploy" ? e.admin : e.kind === "dispute" ? e.signer : e.kind === "resolve" ? e.resolver : e.seller;

  if (d.network !== "testnet") problems.push("It was prepared for another network, not Stellar testnet.");
  if (d.opCount !== 1) problems.push(`It has ${d.opCount} operations instead of one.`);
  if (d.source !== signer) problems.push(`It would be sent from ${d.source}, not from ${signer}.`);
  if (d.opSource !== null) problems.push("Its operation names its own source account.");

  // O-18: a tampered fee must not drain the signer's XLM. Trustless Work's fees are 0.02-0.21 XLM.
  if (d.fee > ESCROW_XLM_NEED) {
    problems.push(`Its fee can reach ${fromStroops(d.fee)} XLM, above the ${fromStroops(ESCROW_XLM_NEED)} XLM Pairy allows.`);
  }

  const nowS = Math.floor(now.getTime() / 1000);
  const tb = d.timeBounds;
  const until = (t: number) => new Date(t * 1000).toISOString();
  const rebuilt = e.kind === "resolve" && e.timePolicy === "browser-rebuilt";
  if (!tb || tb.maxTime === 0) problems.push("It never expires; Trustless Work's transactions expire after 5 minutes.");
  else if (tb.minTime !== 0) problems.push("It cannot be sent until a later time.");
  else if (tb.maxTime <= nowS) problems.push(`It expired at ${until(tb.maxTime)}. Prepare it again.`);
  else if (rebuilt && tb.maxTime < nowS + REBUILT_MIN_S) {
    problems.push(`It expires at ${until(tb.maxTime)}, in less than 10 minutes. Prepare it again.`);
  } else if (rebuilt && tb.maxTime > nowS + REBUILT_MAX_S) {
    problems.push(`It stays valid until ${until(tb.maxTime)}, more than 24 hours ahead.`);
  } else if (!rebuilt && tb.maxTime > nowS + TW_VALIDITY_S + CLOCK_SLACK_S) {
    problems.push(`It stays valid until ${until(tb.maxTime)}, longer than the 5 minutes Trustless Work gives.`);
  }

  if (d.opType !== "invokeHostFunction" || !d.contractId) {
    problems.push(`Its operation is ${d.opType}, not a contract call.`);
    return problems;
  }

  // Before WP-11 pins the factory, the deploy is derived from the factory it calls (FIXES F-02).
  if (e.kind === "deploy" && TW_FACTORY_CONTRACT_ID === null) {
    console.warn(JSON.stringify({ evt: "escrow.factory_unpinned", factory: d.contractId }));
  }
  const contract = e.kind === "deploy" ? (TW_FACTORY_CONTRACT_ID ?? d.contractId) : e.contractId;
  if (d.contractId !== contract) problems.push(`It calls contract ${d.contractId}, not ${contract}.`);
  if (d.fn !== FN[e.kind]) problems.push(`It calls ${d.fn}, not ${FN[e.kind]}.`);
  if (d.args.length !== ARG_COUNT[e.kind]) problems.push(`It passes ${d.args.length} arguments to ${d.fn}, not ${ARG_COUNT[e.kind]}.`);
  if (d.args[0] !== signer) problems.push(`It acts for ${show(d.args[0])}, not ${signer}.`);

  // The whole authorization tree: one root, the call itself, signed by the transaction's source.
  if (d.authRoots.length !== 1) problems.push(`It carries ${d.authRoots.length} authorizations instead of one.`);
  const root = d.authRoots[0];
  if (root) {
    // FIXES F-04: no address-credentials path; S-19 resolved with envelope signatures.
    if (root.credentials !== "source") {
      problems.push(`Its authorization asks ${root.address ?? "another account"} to sign inside the call; Pairy expects only the transaction's own signature.`);
    }
    if (root.contractId !== d.contractId || root.fn !== d.fn || canon(root.args) !== canon(d.args)) {
      problems.push("Its authorization is for a different call than the one it makes.");
    }
    const expected = expectedSubInvocations(d, e);
    const unexpected = root.subInvocations.filter((s) => !expected.some((x) => canon(x) === canon(s)));
    const missing = expected.filter((x) => !root.subInvocations.some((s) => canon(x) === canon(s)));
    problems.push(
      ...unexpected.map((s) => `Its authorization also lets ${s.fn} run on ${s.contractId || "a new contract"}.`),
      ...missing.map((x) => `Its authorization lacks the expected ${x.fn} on ${x.contractId}.`),
    );
    if (!unexpected.length && !missing.length && root.subInvocations.length !== expected.length) {
      problems.push("Its authorization repeats a call.");
    }
  }

  switch (e.kind) {
    case "deploy": {
      const wasm = d.args[1] instanceof Uint8Array ? hex(d.args[1]) : show(d.args[1]);
      if (TW_ESCROW_WASM_HASH !== null && wasm !== TW_ESCROW_WASM_HASH) {
        problems.push(`It installs contract code ${wasm}, not Trustless Work's escrow ${TW_ESCROW_WASM_HASH}.`);
      }
      if (d.args[3] !== "initialize_escrow") problems.push(`It initialises the escrow with ${show(d.args[3])}, not initialize_escrow.`);
      if (canon(d.args[5]) !== canon([e.admin, d.args[1]])) problems.push("Its constructor arguments are not the admin and the escrow code.");
      const init = Array.isArray(d.args[4]) ? d.args[4] : [];
      if (init.length !== 1) problems.push(`It initialises the escrow with ${init.length} arguments, not one.`);
      problems.push(...escrowProblems(init[0], e.terms));
      let derived = "";
      try {
        derived = deriveEscrowId(d);
      } catch {
        // reported just below
      }
      if (derived !== e.contractId) {
        problems.push(`The escrow address Trustless Work returned (${e.contractId}) is not the one this transaction creates (${derived || "unknown"}).`);
      }
      break;
    }
    case "fund":
      problems.push(...escrowProblems(d.args[1], e.terms));
      if (d.args[2] !== e.amountStroops) problems.push(`It moves ${show(d.args[2])}, not ${show(e.amountStroops)}.`);
      break;
    case "release":
      if (TW_FEE_ADDRESS !== null && d.args[1] !== TW_FEE_ADDRESS) problems.push(`It sends Trustless Work's fee to ${show(d.args[1])}, not ${TW_FEE_ADDRESS}.`);
      if (canon(d.args[2]) !== canon([0])) problems.push("It releases other milestones than the trade's one.");
      break;
    case "dispute":
      if (d.args[1] !== DISPUTE_REASON) problems.push(`Its dispute reason is "${show(d.args[1])}", not Pairy's.`);
      break;
    case "resolve": {
      if (TW_FEE_ADDRESS !== null && d.args[1] !== TW_FEE_ADDRESS) problems.push(`It sends Trustless Work's fee to ${show(d.args[1])}, not ${TW_FEE_ADDRESS}.`);
      const pays = payouts(d.args[2]);
      if (pays.length !== 1 || pays[0][0] !== e.recipient || pays[0][1] !== e.amountStroops) {
        const found = pays.map(([to, amount]) => `${show(amount)} to ${to}`).join(" and ") || "nothing";
        problems.push(`It pays out ${found}, not ${show(e.amountStroops)} to ${e.recipient}.`);
      }
      break;
    }
  }
  return problems;
}

/**
 * Trustless Work's unsigned transaction with only its maxTime changed (O-17),
 * edited in the XDR itself so every other byte stays Trustless Work's.
 * TransactionBuilder.cloneFrom would drop the Soroban data in SDK 17.2.1.
 * Returns the same shape as Trustless Work's prepare, ready for decodeEscrowCall.
 */
export function rebuildMaxTime(unsignedXdr: string, maxTimeSeconds: number): { unsignedXdr: string; txHash: string } {
  const env = xdr.TransactionEnvelope.fromXDR(unsignedXdr, "base64").toXdrObject();
  if (env.type !== 2 || env.v1.tx.cond.type !== 1) throw new Error("Only a transaction with time bounds can be re-timed.");
  if (env.v1.signatures.length) throw new Error("This transaction is already signed; re-time it before anyone signs.");
  const cond = { type: 1 as const, timeBounds: { ...env.v1.tx.cond.timeBounds, maxTime: BigInt(maxTimeSeconds) } };
  const out = xdr.TransactionEnvelope.fromXdrObject({ ...env, v1: { ...env.v1, tx: { ...env.v1.tx, cond } } }).toXdr("base64");
  return { unsignedXdr: out, txHash: hex(TransactionBuilder.fromXDR(out, NETWORK_PASSPHRASE).hash()) };
}

/**
 * The server's check after rebuildMaxTime (O-17): the re-timed transaction is
 * Trustless Work's, byte for byte, except for maxTime. Source, fee, sequence,
 * memo, minTime, the operation, its authorization and the Soroban data all
 * must match; anything else that differs is refused.
 */
export function onlyMaxTimeChanged(twXdr: string, rebuiltXdr: string): boolean {
  const tw = xdr.TransactionEnvelope.fromXDR(twXdr, "base64").toXdrObject();
  const rebuilt = xdr.TransactionEnvelope.fromXDR(rebuiltXdr, "base64").toXdrObject();
  if (tw.type !== 2 || rebuilt.type !== 2 || tw.v1.tx.cond.type !== 1 || rebuilt.v1.tx.cond.type !== 1) return false;
  // Put Trustless Work's maxTime back: then the two transactions must be the same bytes.
  const cond = { type: 1 as const, timeBounds: { ...rebuilt.v1.tx.cond.timeBounds, maxTime: tw.v1.tx.cond.timeBounds.maxTime } };
  const restored = xdr.Transaction.fromXdrObject({ ...rebuilt.v1.tx, cond }).toXdr("base64");
  return restored === xdr.Transaction.fromXdrObject(tw.v1.tx).toXdr("base64");
}

/** One line for the signing screens, e.g. "Fund this trade's escrow with 100 USDC". */
export function describeEscrowCall(d: DecodedCall): string {
  switch (d.fn) {
    case FN.deploy: {
      const init = Array.isArray(d.args[4]) ? (d.args[4][0] as { amount?: unknown } | undefined) : undefined;
      return typeof init?.amount === "bigint" ? `Create this trade's escrow for ${fromStroops(init.amount)} USDC` : "Create this trade's escrow";
    }
    case FN.fund:
      return typeof d.args[2] === "bigint" ? `Fund this trade's escrow with ${fromStroops(d.args[2])} USDC` : "Fund this trade's escrow";
    case FN.release:
      return "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee";
    case FN.dispute:
      return "Open a dispute on this trade's escrow";
    case FN.resolve: {
      const pays = payouts(d.args[2]);
      const [to, amount] = pays[0] ?? [];
      if (pays.length !== 1 || typeof amount !== "bigint") return "Resolve the dispute on this trade's escrow";
      return `Pay this trade's escrow to ${short(to)}: ${fromStroops(netAfterFee(amount))} USDC after Trustless Work's 0.3% fee`;
    }
    default:
      return `Call ${d.fn || "something other than a contract"} on ${short(d.contractId)}`;
  }
}

/** A resolve's distribution, {address: stroops}, as entries. */
function payouts(v: unknown): [string, unknown][] {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
}
