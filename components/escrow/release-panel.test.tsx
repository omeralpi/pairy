import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { expectedTerms } from "@/lib/escrow/terms";
import { submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { stepRunning } from "@/lib/trade/pending-tx";

// The seller's release (protected trade, funded, no dispute): one signature
// (FIXES F-20). The flow presses the captured Release button outside React
// with Trustless Work's real Gate D2 release and the real browser check,
// signing, sending and pending-tx code; Horizon, Pairy's API, the escrow read
// and the wallet are stubs. The clock is Gate D2's, inside the release's 5 minutes.

const mutations = vi.hoisted(() => ({}) as Record<string, (input: unknown) => Promise<unknown>>);
const now = vi.hoisted(() => ({ trade: {} as Record<string, unknown> }));
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown; disabled?: boolean }[]);
const wallet = vi.hoisted(() => ({ result: { wallet: null as unknown, ready: true } }));

vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
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

const { ReleasePanel } = await import("./release-panel");
const { readEscrowOnChain } = await import("./escrow-steps");

const RELEASE = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/gate-d2-release.json"), "utf8"));
const prepared = RELEASE.response.body as { unsignedXdr: string; txHash: string };

// Gate D2's trade, now funded.
const ID = "11111111-1111-4111-8111-111111111111";
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const trade = {
  id: ID,
  mode: "protected",
  state: "funded",
  role: "seller",
  seller: SELLER,
  buyer: BUYER,
  asset: "USDC",
  amount: "5.0000000",
  disputed: false,
  escrowAdmin: ADMIN,
  escrowContractId: ESCROW,
  createTx: "c".repeat(64),
  fundTx: "f".repeat(64),
  releaseTx: null as string | null,
  fundedAt: new Date("2026-11-24T08:28:10Z"),
  stallNudge: false,
};
const terms = expectedTerms({ buyer: BUYER, seller: SELLER, amount: trade.amount, escrowAdmin: ADMIN });
const onChain = (status = {}) => ({
  terms,
  status: { disputed: false, released: false, resolved: false, balanceStroops: 50_000_000n, ...status },
  wasmHash: TW_ESCROW_WASM_HASH!,
});
const NUDGE = "If the buyer never came, open a dispute: it's the way to a refund.";

const render = (t: Partial<typeof trade> = {}) => {
  buttons.length = 0;
  return renderToStaticMarkup(<ReleasePanel trade={{ ...trade, ...t } as never} />).replaceAll("&#x27;", "'");
};
const releaseButton = () => buttons.find((b) => b.label.startsWith("Release"));

let store: Map<string, string>;
let writes: string[];

beforeEach(() => {
  wallet.result = { wallet: { kind: "device", publicKey: SELLER, signTransaction: vi.fn() }, ready: true };
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

describe("ReleasePanel on screen", () => {
  it("says to release only with the cash in hand, and what the buyer receives after Trustless Work's 0.3% (netAfterFee)", () => {
    expect(render()).toContain("Release only when you hold the cash. The buyer receives 4.985 USDC; 0.3% goes to Trustless Work.");
    expect(render({ amount: "10.0000000" })).toContain("The buyer receives 9.97 USDC;");
    expect(render({ amount: "12.3456789" })).toContain("The buyer receives 12.3086419 USDC;");
    expect(releaseButton()?.label).toBe("Release 12.3456789 USDC");
  });

  it("lets the seller release with their own wallet, and only with it", () => {
    render();
    expect(releaseButton()?.disabled).toBe(false);
    wallet.result = { wallet: { kind: "device", publicKey: BUYER, signTransaction: vi.fn() }, ready: true };
    expect(render()).toContain("this step must be signed by");
    expect(releaseButton()?.disabled).toBe(true);
  });

  it("never offers a second release while this browser holds one it sent", () => {
    store.set(`pairy:pending-tx:${ID}`, JSON.stringify({ kind: "release", hash: "ab".repeat(32), savedAt: Date.now() }));
    expect(render()).toContain("You already sent the release from this browser.");
    expect(releaseButton()?.disabled).toBe(true);
  });
});

describe("ReleasePanel's stall nudge (D2 §7.3)", () => {
  // trade.byId sets stallNudge from the server's clock; escrow.test.ts moves that clock past funded_at + 72 h.
  it("does not nudge before funded_at + 72 h", () => {
    expect(render({ stallNudge: false })).not.toContain(NUDGE);
  });

  it("points to a dispute once funded_at + 72 h passed with no release or dispute", () => {
    expect(render({ stallNudge: true })).toContain(NUDGE);
  });
});

describe("ReleasePanel releasing the escrow", () => {
  let prepare: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let signed: { xdr: string; summary?: string }[];
  let runningAtRecord: boolean[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(RELEASE.at) + 1000));
    signed = [];
    runningAtRecord = [];
    const key = Keypair.random();
    wallet.result = {
      ready: true,
      wallet: {
        kind: "freighter",
        publicKey: SELLER,
        signTransaction: vi.fn(async (xdr: string, opts?: { summary?: string }) => {
          signed.push({ xdr, summary: opts?.summary });
          const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
          tx.sign(key);
          return tx.toXDR();
        }),
      },
    };
    prepare = vi.fn(async () => ({ ...prepared, summary: "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee" }));
    record = vi.fn(async () => void runningAtRecord.push(stepRunning(ID)));
    mutations["escrow.prepareRelease"] = prepare;
    mutations["escrow.recordRelease"] = record;
    vi.mocked(readEscrowOnChain).mockReset().mockResolvedValue(onChain());
    vi.mocked(submit).mockReset().mockImplementation(async (tx) => ({ hash: Buffer.from(tx.hash()).toString("hex") }) as never);
  });

  const press = async () => {
    render();
    await releaseButton()!.onClick!();
  };

  it("checks Trustless Work's release in this browser, has the seller's wallet sign it with its summary, and records it once", async () => {
    await press();

    expect(prepare).toHaveBeenCalledWith({ tradeId: ID });
    expect(signed).toEqual([{ xdr: prepared.unsignedXdr, summary: "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee" }]);
    expect(readEscrowOnChain).toHaveBeenCalledWith(ESCROW);
    expect(vi.mocked(submit)).toHaveBeenCalledOnce();
    expect(record.mock.calls).toEqual([[{ tradeId: ID, txHash: prepared.txHash }]]);
    expect(runningAtRecord).toEqual([true]);
    expect(stepRunning(ID)).toBe(false);
    expect(writes).toEqual([`pairy:pending-tx:${ID}`]);
    expect(store.size).toBe(0);
  });

  it("never signs a release this browser's check refuses (another seller's)", async () => {
    render({ seller: BUYER, buyer: SELLER });
    await releaseButton()!.onClick!();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends when a dispute landed on chain while the wallet was open", async () => {
    vi.mocked(readEscrowOnChain).mockResolvedValue(onChain({ disputed: true }));
    await press();
    expect(signed).toHaveLength(1);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends when the trade moved on while the wallet was open", async () => {
    now.trade = { ...trade, disputed: true };
    await press();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
