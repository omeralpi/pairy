import { readFileSync } from "node:fs";
import path from "node:path";

import { Address, Keypair, TransactionBuilder, nativeToScVal, xdr, type Transaction } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { expectedTerms } from "@/lib/escrow/terms";
import { submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { stepRunning } from "@/lib/trade/pending-tx";

// The seller's fund (protected trade, escrow_created). The markup shows what
// is on screen; the escrow as this browser read it from Soroban RPC is the
// stubbed useQuery's answer. The flow presses the captured Fund button
// outside React with Trustless Work's real Gate D2 fund, the real browser
// check, signing, sending and pending-tx code, and Horizon, Pairy's API and
// the wallet as stubs. The clock is Gate D2's, inside the fund's 5 minutes.

const read = vi.hoisted(() => ({ result: {} as Record<string, unknown>, options: null as null | { queryKey: unknown[]; queryFn: () => unknown } }));
const preflight = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const mutations = vi.hoisted(() => ({}) as Record<string, (input: unknown) => Promise<unknown>>);
const now = vi.hoisted(() => ({ trade: {} as Record<string, unknown> }));
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown; disabled?: boolean }[]);
const wallet = vi.hoisted(() => ({ result: { wallet: null as unknown, ready: true } }));

vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQuery: (options: typeof read.options) => {
    read.options = options;
    return read.result;
  },
}));
vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useQuery") return () => (path.join(".") === "escrow.preflight" ? preflight.result : { data: undefined });
        if (key === "useMutation") return () => ({ mutateAsync: (input: unknown) => mutations[path.join(".")](input), isPending: false });
        if (key === "useUtils") return () => node([]);
        if (key === "invalidate") return async () => {};
        if (key === "fetch") return async () => now.trade;
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});
vi.mock("@/components/ui/button", () => ({
  Button: (p: { children: React.ReactNode; onClick?: () => unknown; disabled?: boolean }) => {
    buttons.push({ label: [p.children].flat().join(""), onClick: p.onClick, disabled: p.disabled });
    return <button disabled={p.disabled}>{p.children}</button>;
  },
}));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => wallet.result }));
vi.mock("@/lib/stellar/horizon", async (orig) => ({ ...(await orig<typeof import("@/lib/stellar/horizon")>()), submit: vi.fn() }));
vi.mock("./escrow-steps", async (orig) => ({ ...(await orig<typeof import("./escrow-steps")>()), readEscrowOnChain: vi.fn() }));

const { FundPanel } = await import("./fund-panel");
const { readEscrowOnChain, termRows } = await import("./escrow-steps");

const FUND = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/gate-d2-fund.json"), "utf8"));
const prepared = FUND.response.body as { unsignedXdr: string; txHash: string };

// Gate D2's trade (scripts/evidence/out/escrow-release-real.json), now escrow_created.
const ID = "11111111-1111-4111-8111-111111111111";
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const STRANGER = "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN";
const VIEWER = `https://viewer.trustlesswork.com/testnet/v2/${ESCROW}`;
const trade = {
  id: ID,
  mode: "protected",
  state: "escrow_created",
  role: "seller",
  seller: SELLER,
  buyer: BUYER,
  asset: "USDC",
  amount: "5.0000000",
  escrowAdmin: ADMIN,
  escrowContractId: ESCROW,
  createTx: "c".repeat(64),
  fundTx: null as string | null,
  viewerUrl: VIEWER,
};
const terms = expectedTerms({ buyer: BUYER, seller: SELLER, amount: trade.amount, escrowAdmin: ADMIN });
const onChain = (t = {}, status = {}) => ({
  terms: { ...terms, ...t },
  status: { disputed: false, released: false, resolved: false, balanceStroops: 0n, ...status },
  wasmHash: TW_ESCROW_WASM_HASH!,
});
/** The fund with its expected_escrow edited in the call and its authorization alike, then re-hashed. */
type Wire = any;
function tampered(edit: (escrow: Wire) => void) {
  const env: Wire = xdr.TransactionEnvelope.fromXDR(prepared.unsignedXdr, "base64").toXdrObject();
  const op = env.v1.tx.operations[0].body.invokeHostFunctionOp;
  for (const call of [op.hostFunction.invokeContract, op.auth[0].rootInvocation.function.contractFn]) edit(call.args[1]);
  const unsignedXdr = xdr.TransactionEnvelope.fromXdrObject(env).toXdr("base64");
  return { unsignedXdr, txHash: Buffer.from(TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE).hash()).toString("hex") };
}
const field = (struct: Wire, name: string): Wire => struct.map.find((e: Wire) => String(e.key.sym) === name).val;
const address = (a: string) => nativeToScVal(Address.fromString(a)).toXdrObject();
const ACK =
  "I understand the buyer is paid only when I release or the arbiter decides; a dispute I leave unanswered for 24 hours pays the buyer if the buyer says yes.";

const render = (t: Partial<typeof trade> = {}) => {
  buttons.length = 0;
  return renderToStaticMarkup(<FundPanel trade={{ ...trade, ...t } as never} />);
};
const fundButton = () => buttons.find((b) => b.label.startsWith("Fund"));
const text = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

let store: Map<string, string>;
let writes: string[];

beforeEach(() => {
  read.result = { data: onChain(), isLoading: false, error: null, isFetching: false, refetch: async () => {} };
  preflight.result = { data: { ok: true, blockedReason: null, checks: [] }, isLoading: false, error: null };
  wallet.result = { wallet: null, ready: true };
  now.trade = { ...trade };
  store = new Map();
  writes = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k);
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FundPanel on screen", () => {
  it("reads the escrow straight from Soroban RPC, never from Trustless Work", async () => {
    render();
    expect(read.options?.queryKey).toContain(ESCROW);
    vi.mocked(readEscrowOnChain).mockResolvedValueOnce(onChain());
    await read.options!.queryFn();
    expect(readEscrowOnChain).toHaveBeenCalledWith(ESCROW);
  });

  it("says it is reading the escrow, and holds Fund meanwhile", () => {
    read.result = { data: undefined, isLoading: true, error: null, isFetching: true, refetch: async () => {} };
    expect(render()).toContain("Reading the escrow from Stellar testnet…");
    expect(fundButton()?.disabled).toBe(true);
  });

  it("says when Soroban RPC can't be read, with a way to read it again, and holds Fund", () => {
    read.result = { data: undefined, isLoading: false, error: new Error("fetch failed"), isFetching: false, refetch: async () => {} };
    const html = render();
    expect(html).toContain("Could not read the escrow; try again.");
    expect(buttons.some((b) => b.label === "Read it again")).toBe(true);
    expect(fundButton()?.disabled).toBe(true);
  });

  it("shows every term ✓, the viewer link and the acknowledgement, and Fund waits only for the box", () => {
    const html = text(render());
    expect([...html.matchAll(/<li[^>]*data-term="(\w+)"[^>]*data-ok="true"/g)].map((m) => m[1])).toEqual(termRows(onChain(), terms).map((r) => r.id));
    expect(html).toContain(`<a href="${VIEWER}" target="_blank" rel="noreferrer"`);
    expect(html).toContain("Check it on Trustless Work's viewer");
    expect(html).toContain(ACK);
    expect(fundButton()?.label).toBe("Fund 5 USDC");
    expect(fundButton()?.disabled).toBe(true);
    expect(html).toContain("Tick the box above to continue.");
  });

  it("disables Fund on any ✗, saying not to fund this escrow and why", () => {
    read.result = { ...read.result, data: onChain({ disputeResolvers: [STRANGER] }) };
    const html = text(render());
    expect(html).toMatch(/<li[^>]*data-term="disputeResolvers"[^>]*data-ok="false"/);
    expect(html).toContain(`Don't fund this escrow: The escrow's dispute resolvers are ${STRANGER}, not`);
    expect(fundButton()?.disabled).toBe(true);
  });

  it("never offers a second fund while this browser holds one it sent", () => {
    store.set(`pairy:pending-tx:${ID}`, JSON.stringify({ kind: "fund", hash: "ab".repeat(32), savedAt: Date.now() }));
    expect(render()).toContain("You already sent the fund for this escrow from this browser.");
    expect(fundButton()?.disabled).toBe(true);
  });
});

describe("FundPanel funding the escrow", () => {
  let prepare: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let signed: { xdr: string; summary?: string }[];
  let runningAtRecord: boolean[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(FUND.at) + 1000));
    signed = [];
    runningAtRecord = [];
    const key = Keypair.random();
    wallet.result = {
      ready: true,
      wallet: {
        kind: "privy",
        publicKey: SELLER,
        signTransaction: vi.fn(async (xdr: string, opts?: { summary?: string }) => {
          signed.push({ xdr, summary: opts?.summary });
          const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
          tx.sign(key);
          return tx.toXDR();
        }),
      },
    };
    prepare = vi.fn(async () => ({ ...prepared, summary: "Fund this trade's escrow with 5 USDC" }));
    record = vi.fn(async () => void runningAtRecord.push(stepRunning(ID)));
    mutations["escrow.prepareFund"] = prepare;
    mutations["escrow.recordFund"] = record;
    vi.mocked(readEscrowOnChain).mockReset().mockResolvedValue(onChain());
    vi.mocked(submit).mockReset().mockImplementation(async (tx) => ({ hash: Buffer.from(tx.hash()).toString("hex") }) as never);
  });

  const press = async () => {
    render();
    await fundButton()!.onClick!();
  };

  it("checks Trustless Work's fund in this browser, has the seller's wallet sign it with its summary, and records it once", async () => {
    await press();

    expect(prepare).toHaveBeenCalledWith({ tradeId: ID });
    // The summary reaches the wallet's own dialog (pincode, Privy's confirm), whatever the wallet kind.
    expect(signed).toEqual([{ xdr: prepared.unsignedXdr, summary: "Fund this trade's escrow with 5 USDC" }]);
    // Before sending: the trade and the escrow are read again.
    expect(readEscrowOnChain).toHaveBeenCalledWith(ESCROW);
    expect(vi.mocked(submit)).toHaveBeenCalledOnce();
    // Recorded once, by this step, while it still held the trade (useTradeSync leaves it alone meanwhile).
    expect(record.mock.calls).toEqual([[{ tradeId: ID, txHash: prepared.txHash }]]);
    expect(runningAtRecord).toEqual([true]);
    expect(stepRunning(ID)).toBe(false);
    expect(writes).toEqual([`pairy:pending-tx:${ID}`]);
    expect(store.size).toBe(0);
  });

  it("never signs, sends or stores a fund whose expected_escrow Trustless Work changed and re-hashed", async () => {
    prepare.mockResolvedValueOnce(tampered((escrow) => (field(field(escrow, "roles"), "dispute_resolvers").vec[0] = address(STRANGER))));
    await press();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never signs Trustless Work's fund for this escrow when the trade names another buyer", async () => {
    render({ buyer: STRANGER });
    await fundButton()!.onClick!();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
  });

  it("never sends when the trade was cancelled while the wallet was open", async () => {
    now.trade = { ...trade, state: "cancelled" };
    await press();
    expect(signed).toHaveLength(1);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends when the escrow read again no longer passes, e.g. it already holds USDC", async () => {
    vi.mocked(readEscrowOnChain).mockResolvedValue(onChain({}, { balanceStroops: 50_000_000n }));
    await press();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends a signed fund that is not the transaction this page checked", async () => {
    const other = Keypair.random();
    (wallet.result.wallet as { signTransaction: unknown }).signTransaction = async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
      const changed = TransactionBuilder.cloneFrom(tx, { fee: String(Number(tx.fee) + 1), networkPassphrase: NETWORK_PASSPHRASE }).build();
      changed.sign(other);
      return changed.toXDR();
    };
    await press();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
