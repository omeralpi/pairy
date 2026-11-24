// The fund's and the release's pure parts (WP-35). checkPrepared runs on
// Trustless Work's real Gate D2 fund and release, with Gate D2's trade, inside
// their 5-minute validity; a tampered expected_escrow is edited in the XDR and
// re-hashed, as a Trustless Work that lies consistently would.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Address, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT, TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { checkEscrowTerms, expectedTerms, type EscrowTerms } from "@/lib/escrow/terms";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";

vi.mock("@/lib/escrow/read", async (orig) => ({
  ...(await orig<typeof import("@/lib/escrow/read")>()),
  readEscrow: vi.fn(),
  readWasmHash: vi.fn(),
}));

const { readEscrow, readWasmHash } = await import("@/lib/escrow/read");
const { checkPrepared, disputeBlocked, fundBlocked, readEscrowOnChain, releaseBlocked, termRows } = await import("./escrow-steps");

type Fixture = { at: string; response: { body: { unsignedXdr: string; txHash: string } } };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
const FUND = fixture("gate-d2-fund");
const RELEASE = fixture("gate-d2-release");
const during = (f: Fixture) => new Date(Date.parse(f.at) + 1000);

// Gate D2's trade (scripts/evidence/out/escrow-release-real.json).
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const STRANGER = "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN";
const terms = expectedTerms({ buyer: BUYER, seller: SELLER, amount: "5.0000000", escrowAdmin: ADMIN });
const fund = { kind: "fund" as const, contractId: ESCROW, seller: SELLER, amountStroops: 50_000_000n, terms };
const release = { kind: "release" as const, contractId: ESCROW, seller: SELLER };

/** The fund with its expected_escrow edited in the call and its authorization alike, then re-hashed. */
type Wire = any;
function tampered(edit: (escrow: Wire) => void) {
  const env: Wire = xdr.TransactionEnvelope.fromXDR(FUND.response.body.unsignedXdr, "base64").toXdrObject();
  const op = env.v1.tx.operations[0].body.invokeHostFunctionOp;
  for (const call of [op.hostFunction.invokeContract, op.auth[0].rootInvocation.function.contractFn]) edit(call.args[1]);
  const unsignedXdr = xdr.TransactionEnvelope.fromXdrObject(env).toXdr("base64");
  return { unsignedXdr, txHash: Buffer.from(TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE).hash()).toString("hex") };
}
const entry = (struct: Wire, name: string): Wire => struct.map.find((e: Wire) => String(e.key.sym) === name);
const field = (struct: Wire, name: string): Wire => entry(struct, name).val;
const address = (a: string) => nativeToScVal(Address.fromString(a)).toXdrObject();

describe("checkPrepared: the browser's own check before the wallet signs (DECISIONS 7)", () => {
  it("passes Trustless Work's fund for this trade, and says what the wallet signs and its fee cap", () => {
    const c = checkPrepared(FUND.response.body, fund, during(FUND));
    expect(c.problems).toEqual([]);
    expect(c.summary).toBe("Fund this trade's escrow with 5 USDC");
    expect(c.fee).toBe("0.0146703");
  });

  it("refuses a fund whose expected_escrow names another dispute resolver, though Trustless Work re-hashed it", () => {
    const lying = tampered((escrow) => (field(field(escrow, "roles"), "dispute_resolvers").vec[0] = address(STRANGER)));
    const c = checkPrepared(lying, fund, during(FUND));
    expect(c.problems).toContain(`The escrow's dispute resolvers are ${STRANGER}, not ${ARBITER_ACCOUNT}.`);
  });

  it("refuses a fund whose expected_escrow pays another receiver, or that is not this trade's amount", () => {
    const receiver = tampered((escrow) => (entry(field(escrow, "roles"), "receiver").val = address(STRANGER)));
    expect(checkPrepared(receiver, fund, during(FUND)).problems.join(" ")).toContain(`The escrow's receiver is ${STRANGER}, not ${BUYER}.`);
    expect(checkPrepared(FUND.response.body, { ...fund, amountStroops: 50_000_001n }, during(FUND)).problems.join(" ")).toMatch(/moves 5 USDC, not 5.0000001 USDC/);
  });

  it("refuses it once its 5 minutes are over, and what is not a transaction, without throwing", () => {
    expect(checkPrepared(FUND.response.body, fund, new Date(Date.parse(FUND.at) + 10 * 60_000)).problems.join(" ")).toMatch(/expired/);
    expect(checkPrepared({ ...FUND.response.body, unsignedXdr: "not xdr" }, fund).problems).toEqual([expect.stringMatching(/^It could not be read as a transaction/)]);
  });

  it("passes Trustless Work's release, one signature by the seller, and refuses it for another seller", () => {
    const c = checkPrepared(RELEASE.response.body, release, during(RELEASE));
    expect(c.problems).toEqual([]);
    expect(c.summary).toBe("Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee");
    expect(c.fee).toBe("0.0024095");
    expect(checkPrepared(RELEASE.response.body, { ...release, seller: BUYER }, during(RELEASE)).problems.join(" ")).toContain(`not from ${BUYER}`);
  });
});

describe("termRows: the TermCheckList, from the escrow as this browser read it", () => {
  const read = (t: Partial<EscrowTerms> = {}, status = {}, wasmHash = TW_ESCROW_WASM_HASH!) => ({
    terms: { ...terms, ...t },
    status: { disputed: false, released: false, resolved: false, balanceStroops: 0n, ...status },
    wasmHash,
  });

  it("shows every term ✓ for this trade's escrow: the SOW's four roles first, then the rest, the code and the empty balance", () => {
    const rows = termRows(read(), terms);
    expect(rows.map((r) => r.id)).toEqual([
      "receiver",
      "approvers",
      "releaseSigners",
      "disputeResolvers",
      "platformFeePercent",
      "platform",
      "admin",
      "serviceProviders",
      "otherRoles",
      "amountStroops",
      "tokenContract",
      "milestones",
      "wasm",
      "empty",
    ]);
    expect(rows.every((r) => r.problem === null)).toBe(true);
    expect(rows.find((r) => r.id === "receiver")).toMatchObject({ label: "Receiver", value: expect.stringContaining("the buyer") });
    expect(rows.find((r) => r.id === "disputeResolvers")).toMatchObject({ value: expect.stringContaining("the arbiter account") });
    expect(rows.find((r) => r.id === "amountStroops")).toMatchObject({ value: "5 USDC" });
  });

  it("keeps checkEscrowTerms' order, so the list reads as the check does", () => {
    const everything: EscrowTerms = {
      admin: STRANGER,
      platform: STRANGER,
      receiver: STRANGER,
      approvers: [STRANGER],
      releaseSigners: [STRANGER],
      disputeResolvers: [STRANGER],
      serviceProviders: [STRANGER],
      otherRoles: ["observers x"],
      amountStroops: 1n,
      platformFeePercent: 1,
      tokenContract: "C",
      milestones: [],
    };
    const fields = checkEscrowTerms(everything, terms).map((p) => p.field);
    expect(termRows(read(everything), terms).map((r) => r.id).slice(0, fields.length)).toEqual(fields);
  });

  it("marks the one term that differs with the check's own sentence", () => {
    const rows = termRows(read({ disputeResolvers: [STRANGER] }), terms);
    expect(rows.filter((r) => r.problem).map((r) => [r.id, r.problem])).toEqual([
      ["disputeResolvers", `The escrow's dispute resolvers are ${STRANGER}, not ${ARBITER_ACCOUNT}.`],
    ]);
  });

  it("marks other contract code, and an escrow that already holds USDC or is no longer open", () => {
    expect(termRows(read({}, {}, "00".repeat(32)), terms).find((r) => r.id === "wasm")?.problem).toMatch(/runs contract code 0000/);
    for (const status of [{ balanceStroops: 1n }, { released: true }, { disputed: true }, { resolved: true }]) {
      expect(termRows(read({}, status), terms).find((r) => r.id === "empty")?.problem).not.toBeNull();
    }
  });
});

describe("readEscrowOnChain", () => {
  it("reads the escrow and its code straight from Soroban RPC (read.ts), never through Trustless Work", async () => {
    vi.mocked(readEscrow).mockResolvedValue({ terms, status: { disputed: false, released: false, resolved: false, balanceStroops: 0n } } as never);
    vi.mocked(readWasmHash).mockResolvedValue("ab".repeat(32));
    expect(await readEscrowOnChain(ESCROW)).toEqual({
      terms,
      status: { disputed: false, released: false, resolved: false, balanceStroops: 0n },
      wasmHash: "ab".repeat(32),
    });
    expect(readEscrow).toHaveBeenCalledWith(ESCROW);
    expect(readWasmHash).toHaveBeenCalledWith(ESCROW);
  });
});

describe("fundBlocked", () => {
  const rows = termRows(
    { terms, status: { disputed: false, released: false, resolved: false, balanceStroops: 0n }, wasmHash: TW_ESCROW_WASM_HASH! },
    terms,
  );
  const ok = {
    unreported: null,
    pending: null,
    read: { loading: false, failed: false, rows },
    preflight: { loading: false, error: null, blockedReason: null },
    acknowledged: true,
    wallet: null,
  };

  it("lets the seller fund once every term is ✓, the checks pass, the box is ticked and the wallet is the seller's", () => {
    expect(fundBlocked(ok)).toBeNull();
    expect(fundBlocked({ ...ok, wallet: "Connect your wallet to sign." })).toBe("Connect your wallet to sign.");
    expect(fundBlocked({ ...ok, acknowledged: false })).toBe("Tick the box above to continue.");
  });

  it("holds it while the escrow is being read, and when Soroban RPC can't be read", () => {
    expect(fundBlocked({ ...ok, read: { loading: true, failed: false, rows: undefined } })).toBe("Reading the escrow from Stellar testnet…");
    expect(fundBlocked({ ...ok, read: { loading: false, failed: true, rows: undefined } })).toBe("Could not read the escrow; try again.");
  });

  it("holds it on any ✗, naming the problem, before anything else the seller could fix", () => {
    const bad = rows.map((r) => (r.id === "disputeResolvers" ? { ...r, problem: "The escrow's dispute resolvers are X, not Y." } : r));
    expect(fundBlocked({ ...ok, read: { ...ok.read, rows: bad }, acknowledged: false })).toBe(
      "Don't fund this escrow: The escrow's dispute resolvers are X, not Y.",
    );
  });

  it("passes on why the server's checks fail", () => {
    expect(fundBlocked({ ...ok, preflight: { loading: false, error: null, blockedReason: "You need 5 USDC but hold 0 USDC." } })).toBe(
      "You need 5 USDC but hold 0 USDC.",
    );
  });

  it("never lets a second fund start while one from this browser is on its way or unrecorded", () => {
    expect(fundBlocked({ ...ok, unreported: "ab".repeat(32) })).toMatch(/not recorded yet.*don't fund it again/);
    expect(fundBlocked({ ...ok, pending: { kind: "fund" } })).toMatch(/already sent the fund/);
    expect(fundBlocked({ ...ok, pending: { kind: "create" } })).toBeNull();
  });
});

describe("releaseBlocked", () => {
  it("never lets a second release start while one from this browser is on its way or unrecorded", () => {
    expect(releaseBlocked({ unreported: null, pending: null, wallet: null })).toBeNull();
    expect(releaseBlocked({ unreported: "ab".repeat(32), pending: null, wallet: null })).toMatch(/not recorded yet.*don't release it again/);
    expect(releaseBlocked({ unreported: null, pending: { kind: "release" }, wallet: null })).toMatch(/already sent the release/);
    expect(releaseBlocked({ unreported: null, pending: { kind: "fund" }, wallet: "Connect your wallet to sign." })).toBe("Connect your wallet to sign.");
  });
});

describe("checkPrepared on a dispute, and disputeBlocked (WP-37)", () => {
  // WP-15's test-arbiter buyer exit: the buyer disputed escrow CD2SQ73L….
  const DISPUTE = fixture("exits-test-dispute-buyer");
  const dispute = { kind: "dispute" as const, contractId: "CD2SQ73L66QEHOZTFZ3EVTEHQCOP64KSC4KZHFMB2NMRKACSTIF5EAXX", signer: "GB4SRNTZC2IPDRHBQMAMHVRNUOEUEIGLJKPP7SXBLRYKD4EC6RMJ34TT" };

  it("passes Trustless Work's dispute for this trader with Pairy's fixed reason, and refuses it for the other trader", () => {
    const c = checkPrepared(DISPUTE.response.body, dispute, during(DISPUTE));
    expect(c.problems).toEqual([]);
    expect(c.summary).toBe("Open a dispute on this trade's escrow");
    const seller = "GBHJ2SXQHGE44MWYUELDSLP3CCMYPA4RFNFIOAKHI6TC5SZJ4I6J6G3E";
    expect(checkPrepared(DISPUTE.response.body, { ...dispute, signer: seller }, during(DISPUTE)).problems.join(" ")).toContain(seller);
  });

  it("never lets a second dispute start while one from this browser is on its way or unrecorded", () => {
    expect(disputeBlocked({ unreported: null, pending: null, wallet: null })).toBeNull();
    expect(disputeBlocked({ unreported: "ab".repeat(32), pending: null, wallet: null })).toMatch(/not recorded yet.*don't send it again/);
    expect(disputeBlocked({ unreported: null, pending: { kind: "dispute" }, wallet: null })).toMatch(/already sent a dispute/);
    expect(disputeBlocked({ unreported: null, pending: { kind: "release" }, wallet: "Connect your wallet to sign." })).toBe("Connect your wallet to sign.");
  });
});
