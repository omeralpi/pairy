import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, TransactionFailedError, type Transaction } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fundWithFriendbot, loadAccount, submit } from "@/lib/stellar/horizon";

// The seller's escrow creation. The markup shows what is on screen. The flow
// runs by pressing the captured "Create the escrow" button outside React
// (state updates after a server render are no-ops), with Horizon, Friendbot
// and Pairy's API as stubs, and the real one-time key, signing, sending and
// pending-tx code. checkCreation is stubbed here because Trustless Work's
// recorded deploy names its own creation key; create-flow.test.ts runs the
// real check on it.

const preflight = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const mutations = vi.hoisted(() => ({}) as Record<string, (input: unknown) => Promise<unknown>>);
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown; disabled?: boolean }[]);

vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useQuery") return () => (path.join(".") === "escrow.preflight" ? preflight.result : { data: undefined });
        if (key === "useMutation") return () => ({ mutateAsync: (input: unknown) => mutations[path.join(".")](input), isPending: false });
        if (key === "useUtils") return () => node([]);
        if (key === "invalidate") return async () => {};
        if (key === "fetch") return async () => ({ createTx: null });
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});
vi.mock("@/components/ui/button", () => ({
  Button: (p: { children: string; onClick?: () => unknown; disabled?: boolean }) => {
    buttons.push({ label: String(p.children), onClick: p.onClick, disabled: p.disabled });
    return <button disabled={p.disabled}>{p.children}</button>;
  },
}));
vi.mock("@/lib/stellar/horizon", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/horizon")>()),
  loadAccount: vi.fn(),
  fundWithFriendbot: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/lib/escrow/read", async (orig) => ({
  ...(await orig<typeof import("@/lib/escrow/read")>()),
  readEscrow: vi.fn(async () => ({})),
}));
vi.mock("./create-flow", async (orig) => ({
  ...(await orig<typeof import("./create-flow")>()),
  checkCreation: vi.fn(),
}));

const { CreatePanel } = await import("./create-panel");
const { checkCreation } = await import("./create-flow");

const DEPLOY = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/gate-d2-deploy.json"), "utf8")).response.body as {
  unsignedXdr: string;
  txHash: string;
  contractId: string;
};
const ID = "11111111-1111-4111-8111-111111111111";
const trade = {
  id: ID,
  mode: "protected",
  state: "agreed",
  role: "seller",
  openedBy: "buyer",
  seller: "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y",
  buyer: "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ",
  asset: "USDC",
  amount: "5.0000000",
  escrowAdmin: null as string | null,
  escrowContractId: null as string | null,
  createTx: null,
};
const OK = { problems: [], summary: "Create this trade's escrow for 5 USDC", fee: "0.2" };
const checks = (failing?: { id: string; detail: string }) => [
  { id: "bothAccepted", ok: true, label: "Both of you accepted the protected-trade terms", detail: null },
  { id: "sellerUsdc", ok: true, label: "You hold 5 USDC", detail: null },
  failing
    ? { id: failing.id, ok: false, label: "The buyer can receive USDC", detail: failing.detail }
    : { id: "buyerTrustline", ok: true, label: "The buyer can receive USDC", detail: null },
];
const ready = () => {
  preflight.result = { data: { ok: true, blockedReason: null, checks: checks() }, isLoading: false, error: null, isFetching: false };
};

const render = (t: Partial<typeof trade> = {}) => {
  buttons.length = 0;
  return renderToStaticMarkup(<CreatePanel trade={{ ...trade, ...t } as never} />);
};
const createButton = () => buttons.find((b) => b.label === "Create the escrow");

// Every write to the browser's storage, by area.
let writes: { area: string; key: string; value: string }[];
let store: Map<string, string>;
function storageArea(area: string) {
  return {
    getItem: (k: string) => store.get(`${area}:${k}`) ?? null,
    setItem: (k: string, v: string) => {
      writes.push({ area, key: k, value: v });
      store.set(`${area}:${k}`, v);
    },
    removeItem: (k: string) => void store.delete(`${area}:${k}`),
  };
}

beforeEach(() => {
  ready();
  writes = [];
  store = new Map();
  vi.stubGlobal("localStorage", storageArea("local"));
  vi.stubGlobal("sessionStorage", storageArea("session"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CreatePanel on screen", () => {
  it("says the one-time key stays in this browser, and lists the steps in order", () => {
    const html = render();
    expect(html).toContain("A one-time key is made in this browser to create the escrow. It is never sent to Pairy and is dropped once the escrow exists.");
    const steps = [...html.matchAll(/<li[^>]*data-step="(\w+)"/g)].map((m) => m[1]);
    expect(steps).toEqual(["key", "friendbot", "prepare", "check", "sign", "submit", "record"]);
  });

  it("shows the checks and lets the seller create the escrow once they all pass", () => {
    const html = render();
    expect(html).toContain("The buyer can receive USDC");
    expect(createButton()?.disabled).toBe(false);
  });

  it("waits for the checks, and holds the button while one fails, saying why", () => {
    preflight.result = { data: undefined, isLoading: true, error: null, isFetching: true };
    expect(render()).toContain("Checking both accounts on Stellar testnet…");
    expect(createButton()?.disabled).toBe(true);

    const detail = "The buyer needs to add a USDC trustline first. Without it Trustless Work cannot create the escrow.";
    preflight.result = {
      data: { ok: false, blockedReason: detail, checks: checks({ id: "buyerTrustline", detail }) },
      isLoading: false,
      error: null,
      isFetching: false,
    };
    const html = render();
    expect(html).toContain(detail);
    expect(html).toContain("Sort out the item above, then create the escrow.");
    expect(createButton()?.disabled).toBe(true);
  });

  it("never offers a second creation while this browser holds one it sent", () => {
    store.set(`local:pairy:pending-tx:${ID}`, JSON.stringify({ kind: "create", hash: "ab".repeat(32), savedAt: Date.now() }));
    expect(render({ escrowAdmin: "GADMIN" })).toContain("You already sent an escrow creation for this trade from this browser.");
    expect(createButton()?.disabled).toBe(true);
  });

  it("says when a creation was prepared before, from this browser or another", () => {
    expect(render()).not.toContain("was prepared for this trade before");
    expect(render({ escrowAdmin: "GADMIN", escrowContractId: DEPLOY.contractId })).toContain(
      "An escrow creation was prepared for this trade before, from this browser or another.",
    );
  });
});

describe("CreatePanel creating the escrow", () => {
  let made: Keypair[];
  let prepare: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    made = [];
    const random = Keypair.random;
    vi.spyOn(Keypair, "random").mockImplementation(() => {
      const k = random.call(Keypair);
      made.push(k);
      return k;
    });
    prepare = vi.fn(async () => ({ ...DEPLOY, summary: OK.summary }));
    record = vi.fn(async () => ({}));
    mutations["escrow.prepareCreate"] = prepare;
    mutations["escrow.recordCreate"] = record;
    vi.mocked(checkCreation).mockReset().mockReturnValue(OK);
    // A fresh account until Friendbot opens it.
    const open = new Set<string>();
    vi.mocked(loadAccount).mockReset().mockImplementation(async (k) => (open.has(k) ? ({} as never) : null));
    vi.mocked(fundWithFriendbot).mockReset().mockImplementation(async (k) => void open.add(k));
    vi.mocked(submit).mockReset().mockImplementation(async (tx) => ({ hash: Buffer.from(tx.hash()).toString("hex") }) as never);
  });

  /** The button as one render shows it: pressing it again is a retry on the same screen. */
  const press = () => {
    render();
    const b = createButton();
    expect(b?.disabled).toBe(false);
    return async () => {
      await b!.onClick!();
    };
  };

  it("makes the key in memory, has it sign the checked deploy, and stores nothing but the deploy's public hash", async () => {
    await press()();

    expect(made).toHaveLength(1);
    const key = made[0];
    const secret = key.secret();
    expect(vi.mocked(fundWithFriendbot)).toHaveBeenCalledWith(key.publicKey());
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith({ tradeId: ID, admin: key.publicKey() });
    expect(vi.mocked(checkCreation)).toHaveBeenCalledWith(expect.objectContaining({ unsignedXdr: DEPLOY.unsignedXdr }), expect.objectContaining({ id: ID }), key.publicKey());

    const sent = vi.mocked(submit).mock.calls[0][0] as Transaction;
    expect(sent.signatures).toHaveLength(1);
    expect(key.verify(sent.hash(), sent.signatures[0].signature.value)).toBe(true);
    expect(record).toHaveBeenCalledWith({ tradeId: ID, txHash: DEPLOY.txHash });

    // Only the pending hash was ever written, and it was cleared once recorded.
    expect(writes).toEqual([{ area: "local", key: `pairy:pending-tx:${ID}`, value: expect.stringContaining(`"kind":"create","hash":"${DEPLOY.txHash}"`) }]);
    expect(store.size).toBe(0);
    const everything = JSON.stringify({
      writes,
      prepare: prepare.mock.calls,
      record: record.mock.calls,
      horizon: [vi.mocked(loadAccount).mock.calls, vi.mocked(fundWithFriendbot).mock.calls],
    });
    expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it("never signs or sends a deploy this browser's check refuses; the unused key waits for a retry", async () => {
    vi.mocked(checkCreation).mockReturnValueOnce({ problems: ["It would be sent from GX, not from GY."], summary: OK.summary, fee: "0.2" });
    const create = press();

    await create();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    await create();
    expect(made).toHaveLength(1);
    expect(prepare.mock.calls).toEqual([[{ tradeId: ID, admin: made[0].publicKey() }], [{ tradeId: ID, admin: made[0].publicKey() }]]);
    expect(vi.mocked(fundWithFriendbot)).toHaveBeenCalledOnce();
    expect(vi.mocked(submit)).toHaveBeenCalledOnce();
  });

  it("never sends a signed creation whose hash is not the one Trustless Work named", async () => {
    prepare.mockResolvedValueOnce({ ...DEPLOY, txHash: "00".repeat(32), summary: OK.summary });
    await press()();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("stops before Trustless Work is asked when Friendbot fails, and the retry keeps the key it may have been funded for", async () => {
    vi.mocked(fundWithFriendbot).mockRejectedValueOnce(new Error("Friendbot, the testnet faucet, didn't fund this account (HTTP 502)."));
    const create = press();

    await create();
    expect(prepare).not.toHaveBeenCalled();

    // Funded from Stellar Lab in the meantime: Friendbot is not asked again.
    vi.mocked(loadAccount).mockResolvedValue({} as never);
    await create();
    expect(made).toHaveLength(1);
    expect(vi.mocked(fundWithFriendbot)).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith({ tradeId: ID, admin: made[0].publicKey() });
  });

  it("drops the key once it has signed: when the network refuses the deploy, the next try makes a new one", async () => {
    vi.mocked(submit).mockRejectedValueOnce(
      new TransactionFailedError("Transaction submission failed. Server responded: 400 Bad Request", {
        status: 400,
        statusText: "Bad Request",
        data: { extras: { result_codes: { transaction: "tx_too_late" } } },
      } as never),
    );
    const create = press();

    await create();
    expect(record).not.toHaveBeenCalled();
    await create();

    expect(made).toHaveLength(2);
    expect(made[0].publicKey()).not.toBe(made[1].publicKey());
    expect(prepare.mock.calls.map(([input]) => (input as { admin: string }).admin)).toEqual([made[0].publicKey(), made[1].publicKey()]);
    expect(record).toHaveBeenCalledOnce();
  });
});
