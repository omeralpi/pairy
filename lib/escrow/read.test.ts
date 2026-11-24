// readEscrow and readWasmHash against Soroban RPC answers recorded from real
// escrows on testnet (tests/fixtures/soroban-rpc): WP-11's Gate D2 escrow and
// WP-03's escrows A, B and C. fetch is replaced in every test and answers only
// the recorded requests, so CI never reaches the network and the requests
// themselves (the storage keys, the simulation) are pinned.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Networks, TransactionBuilder, nativeToScVal, xdr, type Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT, MILESTONE_DESCRIPTION, PLATFORM_ACCOUNT, TW_ESCROW_WASM_HASH, USDC_SAC } from "./config";
import { EscrowNotFoundError, readEscrow, readWasmHash } from "./read";
import { checkEscrowTerms, expectedTerms } from "./terms";

type Entry = { key: string; xdr: string; lastModifiedLedgerSeq: number; liveUntilLedgerSeq: number };
type Call = {
  request: { method: string; params: { keys?: string[]; transaction?: string } };
  response: { result: { entries?: Entry[]; latestLedger: number } };
};
type Recording = { contractId: string; calls: Call[] };

const recording = (name: string): Recording =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/soroban-rpc", `${name}.json`), "utf8"));

const RPC_URL = "https://soroban-testnet.stellar.org";
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Answers each JSON-RPC request with the recorded answer to the same method and params; any other request fails. */
function replay(...calls: Call[]) {
  const sent: Call["request"][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      const hit = calls.find((c) => c.request.method === body.method && JSON.stringify(c.request.params) === JSON.stringify(body.params));
      if (new URL(String(url)).href !== new URL(RPC_URL).href || !hit) {
        throw new Error(`unrecorded request to ${url}: ${body.method} ${JSON.stringify(body.params)}`);
      }
      return new Response(JSON.stringify(hit.response), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** readEscrow asks for the instance, the ["Escrow"] entry and the escrow's USDC balance entry, in this order. */
const KIND = { instance: 0, escrow: 1, balance: 2 } as const;
/** A recorded getLedgerEntries answer, edited as Soroban RPC would answer for another state of the same escrow. */
function edited(call: Call, edit: (entry: Entry, kind: keyof typeof KIND) => Entry | null): Call {
  const keys = call.request.params.keys!;
  const kindOf = (e: Entry) => (Object.keys(KIND) as (keyof typeof KIND)[]).find((k) => keys[KIND[k]] === e.key)!;
  const entries = call.response.result.entries!.map((e) => edit({ ...e }, kindOf(e))).filter((e): e is Entry => e !== null);
  return { request: call.request, response: { ...call.response, result: { ...call.response.result, entries } } };
}

/** The Gate D2 release's parties (scripts/evidence/out/escrow-release-real.json). */
const GATE = {
  admin: "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5",
  seller: "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y",
  buyer: "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ",
};
const gateD2 = recording("gate-d2");
const [entriesCall, instanceCall, simulationCall] = gateD2.calls;

describe("readEscrow", () => {
  it("reads the Gate D2 escrow's terms and state from its ledger entries, in one request", async () => {
    const sent = replay(entriesCall);
    const read = await readEscrow(gateD2.contractId);

    expect(sent).toEqual([entriesCall.request]);
    expect(read.terms).toEqual({
      admin: GATE.admin,
      platform: PLATFORM_ACCOUNT,
      receiver: GATE.buyer,
      approvers: [GATE.seller],
      releaseSigners: [GATE.seller],
      disputeResolvers: [ARBITER_ACCOUNT],
      serviceProviders: [GATE.seller],
      otherRoles: [],
      amountStroops: 50_000_000n,
      platformFeePercent: 0,
      tokenContract: USDC_SAC,
      milestones: [{ description: MILESTONE_DESCRIPTION }],
    });
    expect(read.status).toEqual({ disputed: false, released: true, resolved: false, balanceStroops: 0n });
    expect(read.ttl).toEqual({ latestLedger: 5897481, instanceLiveUntil: 6018006, escrowLiveUntil: 6018006 });
    // The trade's own terms pass Pairy's check.
    expect(checkEscrowTerms(read.terms, expectedTerms({ ...GATE, amount: "5.0000000", escrowAdmin: GATE.admin }))).toEqual([]);
  });

  it("gives the roles Trustless Work's viewer showed for the Gate D2 escrow (WP-11)", async () => {
    replay(entriesCall);
    const { terms } = await readEscrow(gateD2.contractId);
    // The viewer shows each address as its first and last six characters.
    const viewer = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;
    expect({
      approver: terms.approvers.map(viewer),
      serviceProvider: terms.serviceProviders.map(viewer),
      releaseSigner: terms.releaseSigners.map(viewer),
      platform: viewer(terms.platform),
      disputeResolver: terms.disputeResolvers.map(viewer),
      receiver: viewer(terms.receiver),
      admin: viewer(terms.admin),
    }).toEqual({
      approver: ["GA7GKE…SPAP5Y"],
      serviceProvider: ["GA7GKE…SPAP5Y"],
      releaseSigner: ["GA7GKE…SPAP5Y"],
      platform: "GAHSTU…K3ISFW",
      disputeResolver: ["GCAQSD…PAXCPH"],
      receiver: "GB2HNR…5TZOYQ",
      admin: "GCITNS…AE5BH5",
    });
  });

  // WP-03's escrows: a throwaway platform and resolver, seller GBMI…3NR4, buyer GDPD…NDYV.
  const WP03 = {
    seller: "GBMIVYQOGG7M5Z43RKXDFC5AZPBPJOM4VHIL2LZXW6N2GCVC7NUY3NR4",
    buyer: "GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV",
    platform: "GACMHHE3UGKORO2X2RPNE74A6L4CQGA6M4JMYTWVRQ2CMLMTQAQRCUSD",
    resolver: "GAGC5NJOBSEGMUS6OAIXB6R5I63JFWZTMVHL2ZXRTLD6336A2KNAG5UI",
  };
  it.each([
    ["wp03-a", "released", "GDQPAMJYN6WIRVN3FHATKGURUYDPQQGBYBGNQ4HJDTCYFGB7A3BZPQ7J", "10.0000000", { disputed: false, released: true, resolved: false }],
    ["wp03-b", "resolved to the buyer", "GDJVGKU2FQCWXMJJ3GVI75JFAZAJSJCEUUR4T4DIVTCD6JNUSD65QPKY", "10.0000000", { disputed: false, released: false, resolved: true }],
    ["wp03-c", "resolved to the seller", "GD3RIWS3JG4LD5JVOU5UWI4BHEDUO2H7GMX5DSGROP3LHH4XMAORA32V", "12.3456789", { disputed: false, released: false, resolved: true }],
  ])("reads %s, %s, and its state", async (name, _, admin, amount, state) => {
    const rec = recording(name);
    replay(rec.calls[0]);
    const read = await readEscrow(rec.contractId);
    expect(read.status).toEqual({ ...state, balanceStroops: 0n });
    // Only the platform differs from what Pairy would ask for: WP-03 named a throwaway one.
    const expected = expectedTerms({ buyer: WP03.buyer, seller: WP03.seller, amount, escrowAdmin: admin }, { resolver: WP03.resolver });
    expect(checkEscrowTerms(read.terms, expected)).toEqual([
      {
        field: "platform",
        expected: PLATFORM_ACCOUNT,
        found: WP03.platform,
        message: `The escrow's platform is ${WP03.platform}, not ${PLATFORM_ACCOUNT}.`,
      },
    ]);
  });

  it("takes the balance from the USDC contract, never from the escrow's stored amount (FIXES X-07)", async () => {
    // As if 0.0000001 USDC fewer than the stored 5 USDC sat in the escrow.
    replay(
      edited(entriesCall, (e, kind) => {
        if (kind !== "balance") return e;
        const data: any = xdr.LedgerEntryData.fromXDR(e.xdr, "base64").toXdrObject();
        data.contractData.val.map.find((f: any) => String(f.key.sym) === "amount").val = nativeToScVal(49_999_999n, { type: "i128" }).toXdrObject();
        return { ...e, xdr: xdr.LedgerEntryData.fromXdrObject(data).toXDR("base64") };
      }),
    );
    const read = await readEscrow(gateD2.contractId);
    expect(read.terms.amountStroops).toBe(50_000_000n);
    expect(read.status.balanceStroops).toBe(49_999_999n);
  });

  it("counts no balance entry as no USDC: the escrow never held any", async () => {
    replay(edited(entriesCall, (e, kind) => (kind === "balance" ? null : e)));
    expect((await readEscrow(gateD2.contractId)).status.balanceStroops).toBe(0n);
  });

  it("still reads an escrow whose storage is archived: Soroban RPC returns it with liveUntilLedgerSeq 0", async () => {
    // archived-contract.json records that answer for an untouched 2025 contract.
    expect(recording("archived-contract").calls[0].response.result.entries![0].liveUntilLedgerSeq).toBe(0);
    replay(edited(entriesCall, (e, kind) => (kind === "balance" ? e : { ...e, liveUntilLedgerSeq: 0 })));
    const read = await readEscrow(gateD2.contractId);
    expect(read.terms.receiver).toBe(GATE.buyer);
    expect(read.ttl).toEqual({ latestLedger: 5897481, instanceLiveUntil: 0, escrowLiveUntil: 0 });
  });

  it("falls back to a read-only simulation of get_escrow from NULL_ACCOUNT, never signed, when the entry is not under its key", async () => {
    const sent = replay(
      edited(entriesCall, (e, kind) => (kind === "escrow" ? null : e)),
      simulationCall,
    );
    const read = await readEscrow(gateD2.contractId);

    expect(sent.map((r) => r.method)).toEqual(["getLedgerEntries", "simulateTransaction"]);
    const tx = TransactionBuilder.fromXDR(sent[1].params.transaction!, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(NULL_ACCOUNT);
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toMatchObject([{ type: "invokeHostFunction" }]);

    replay(entriesCall);
    const direct = await readEscrow(gateD2.contractId);
    expect(read.terms).toEqual(direct.terms);
    expect(read.status).toEqual(direct.status);
    expect(read.ttl).toEqual({ latestLedger: 5897481, instanceLiveUntil: 6018006, escrowLiveUntil: null });
  });

  it("throws EscrowNotFoundError when nothing was ever deployed at the address", async () => {
    const rec = recording("no-contract");
    replay(rec.calls[0]);
    await expect(readEscrow(rec.contractId)).rejects.toBeInstanceOf(EscrowNotFoundError);
  });
});

describe("readWasmHash", () => {
  it("reads the code the Gate D2 escrow runs from its instance alone: Trustless Work's pinned escrow", async () => {
    const sent = replay(instanceCall);
    expect(await readWasmHash(gateD2.contractId)).toBe(TW_ESCROW_WASM_HASH);
    expect(sent).toEqual([instanceCall.request]);
  });

  it("reads an archived instance too", async () => {
    const rec = recording("archived-contract");
    replay(rec.calls[0]);
    expect(await readWasmHash(rec.contractId)).toBe("8ae1550db6f33311e473c1e853d192dd72623cc02c993608a86382469473fa91");
  });

  it("throws EscrowNotFoundError when nothing was ever deployed at the address", async () => {
    const rec = recording("no-contract");
    replay(rec.calls[1]);
    await expect(readWasmHash(rec.contractId)).rejects.toBeInstanceOf(EscrowNotFoundError);
  });
});
