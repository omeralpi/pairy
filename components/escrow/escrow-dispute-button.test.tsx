import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, TransactionBuilder, nativeToScVal, xdr, type Transaction } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { expectedTerms } from "@/lib/escrow/terms";
import { submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { stepRunning } from "@/lib/trade/pending-tx";

// "Flag a problem" on a funded protected trade: either trader signs a dispute
// on the escrow (D2 §7.2, §7.3). The flow confirms the captured dialog outside
// React with Trustless Work's real dispute transactions from WP-15's test run,
// and the real browser check, signing, sending and pending-tx code; Horizon,
// Pairy's API, the escrow read and the wallet are stubs. The clock is the
// dispute's own, inside its 5 minutes.

const mutations = vi.hoisted(() => ({}) as Record<string, (input: unknown) => Promise<unknown>>);
const now = vi.hoisted(() => ({ trade: {} as Record<string, unknown> }));
const confirms = vi.hoisted(() => [] as { title: string; description: string; confirmLabel: string; onConfirm: () => unknown }[]);
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
vi.mock("@/components/confirm-action", () => ({
  ConfirmAction: (p: { title: string; description: string; confirmLabel: string; onConfirm: () => unknown; children: React.ReactNode }) => {
    confirms.push(p);
    return <div data-confirm={p.title}>{p.children}</div>;
  },
}));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => wallet.result }));
vi.mock("@/lib/stellar/horizon", async (orig) => ({ ...(await orig<typeof import("@/lib/stellar/horizon")>()), submit: vi.fn() }));
vi.mock("./escrow-steps", async (orig) => ({ ...(await orig<typeof import("./escrow-steps")>()), readEscrowOnChain: vi.fn() }));

const { EscrowDisputeButton } = await import("./escrow-dispute-button");
const { readEscrowOnChain } = await import("./escrow-steps");

type Fixture = { at: string; response: { body: { unsignedXdr: string; txHash: string } } };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));

/** WP-15's test-arbiter run: in the buyer exit the buyer disputed, in the seller exit the seller. */
type Run = { seller: string; buyer: string; contractId: string; fixture: Fixture };
const RUNS: Record<"buyer" | "seller", Run> = {
  buyer: {
    seller: "GBHJ2SXQHGE44MWYUELDSLP3CCMYPA4RFNFIOAKHI6TC5SZJ4I6J6G3E",
    buyer: "GB4SRNTZC2IPDRHBQMAMHVRNUOEUEIGLJKPP7SXBLRYKD4EC6RMJ34TT",
    contractId: "CD2SQ73L66QEHOZTFZ3EVTEHQCOP64KSC4KZHFMB2NMRKACSTIF5EAXX",
    fixture: fixture("exits-test-dispute-buyer"),
  },
  seller: {
    seller: "GDK5RUFARH53VBUNAX7VWGV2PWYCLSWN45CRE4YBZYM5XHV2KM64LAYI",
    buyer: "GBBLEBFJQQ2GLDVB4GIGLJ2D5W5N7GOEJVJO6CXHPKYVLISDVNLJ3SVI",
    contractId: "CDAITJCFLGRYDPQBTMEJU2MDU24KWZA5W245PEES272DCYGE3VMFJKTM",
    fixture: fixture("exits-test-dispute-seller"),
  },
};
const ID = "11111111-1111-4111-8111-111111111111";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const STRANGER = "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN";
const SUMMARY = "Open a dispute on this trade's escrow";
const DIALOG =
  "This signs a dispute on the escrow. From then on only the arbiter can move the USDC, by the published rule. The reason written on chain is a fixed sentence. Each of you gets 24 hours to answer one question. Trustless Work keeps 0.3% of any exit; the arbiter acts within 72 hours.";

/** The buyer exit's funded trade, from `role`'s side. */
const tradeOf = (role: "seller" | "buyer", run: Run = RUNS.buyer) => ({
  id: ID,
  mode: "protected",
  state: "funded",
  role,
  seller: run.seller,
  buyer: run.buyer,
  asset: "USDC",
  amount: "5.0000000",
  disputed: false,
  escrowAdmin: ADMIN,
  escrowContractId: run.contractId,
  createTx: "c".repeat(64),
  fundTx: "f".repeat(64),
  releaseTx: null as string | null,
  disputeTx: null as string | null,
});
const onChain = (run = RUNS.buyer, status = {}) => ({
  terms: expectedTerms({ buyer: run.buyer, seller: run.seller, amount: "5.0000000", escrowAdmin: ADMIN }),
  status: { disputed: false, released: false, resolved: false, balanceStroops: 50_000_000n, ...status },
  wasmHash: TW_ESCROW_WASM_HASH!,
});

/** Trustless Work's dispute with its arguments edited in the call and its authorization alike, then re-hashed. */
type Wire = any;
function tampered(prepared: Fixture["response"]["body"], edit: (args: Wire[]) => void) {
  const env: Wire = xdr.TransactionEnvelope.fromXDR(prepared.unsignedXdr, "base64").toXdrObject();
  const op = env.v1.tx.operations[0].body.invokeHostFunctionOp;
  for (const call of [op.hostFunction.invokeContract, op.auth[0].rootInvocation.function.contractFn]) edit(call.args);
  const unsignedXdr = xdr.TransactionEnvelope.fromXdrObject(env).toXdr("base64");
  return { unsignedXdr, txHash: Buffer.from(TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE).hash()).toString("hex") };
}

const render = (t: Record<string, unknown> = tradeOf("buyer")) => {
  confirms.length = 0;
  return renderToStaticMarkup(<EscrowDisputeButton trade={t as never} />).replaceAll("&#x27;", "'");
};
const trigger = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Flag a problem<\/button>/)?.[0];
const deviceWallet = (publicKey: string) => ({ kind: "device", publicKey, signTransaction: vi.fn() });

let store: Map<string, string>;
let writes: string[];

beforeEach(() => {
  wallet.result = { wallet: deviceWallet(RUNS.buyer.buyer), ready: true };
  now.trade = tradeOf("buyer");
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

describe("EscrowDisputeButton on a funded escrow", () => {
  it("keeps the words Flag a problem, and its dialog says what signing a dispute does, word for word (D2 §7.3)", () => {
    const html = render();
    expect(trigger(html)).toBeDefined();
    expect(trigger(html)).not.toContain('disabled=""');
    expect(confirms).toHaveLength(1);
    expect(confirms[0].description).toBe(DIALOG);
    expect(confirms[0].title).toBe("Open a dispute on the escrow?");
    expect(confirms[0].confirmLabel).toBe("Sign the dispute");
    expect(html).not.toMatch(/doesn't freeze|only adds a note/);
  });

  it("is offered to the seller too, signing with the seller's own wallet", () => {
    wallet.result = { wallet: deviceWallet(RUNS.buyer.seller), ready: true };
    expect(trigger(render(tradeOf("seller")))).not.toContain('disabled=""');
  });

  it("holds the flag when the connected wallet is not this trader's, and says which one must sign", () => {
    wallet.result = { wallet: deviceWallet(STRANGER), ready: true };
    const html = render();
    expect(trigger(html)).toContain('disabled=""');
    expect(html).toContain("this step must be signed by");
  });
});

describe("EscrowDisputeButton while a dispute is pending", () => {
  it("never offers a second dispute while this browser holds one it sent and Pairy has not recorded", () => {
    store.set(`pairy:pending-tx:${ID}`, JSON.stringify({ kind: "dispute", hash: "ab".repeat(32), savedAt: Date.now() }));
    const html = render();
    expect(html).toContain("You already sent a dispute from this browser. Don't send it again: this page is recording it.");
    expect(trigger(html)).toContain('disabled=""');
  });
});

describe("EscrowDisputeButton signing the dispute", () => {
  let prepare: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let signed: { xdr: string; summary?: string }[];
  let runningAtRecord: boolean[];

  const use = (who: "seller" | "buyer", run: Run) => {
    vi.setSystemTime(new Date(Date.parse(run.fixture.at) + 1000));
    const key = Keypair.random();
    wallet.result = {
      ready: true,
      wallet: {
        kind: "freighter",
        publicKey: run[who],
        signTransaction: vi.fn(async (xdr: string, opts?: { summary?: string }) => {
          signed.push({ xdr, summary: opts?.summary });
          const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
          tx.sign(key);
          return tx.toXDR();
        }),
      },
    };
    now.trade = tradeOf(who, run);
    prepare.mockResolvedValue({ ...run.fixture.response.body, summary: SUMMARY });
    vi.mocked(readEscrowOnChain).mockReset().mockResolvedValue(onChain(run));
  };
  const press = async (t: Record<string, unknown> = now.trade) => {
    render(t);
    await confirms[0].onConfirm();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signed = [];
    runningAtRecord = [];
    prepare = vi.fn();
    record = vi.fn(async () => void runningAtRecord.push(stepRunning(ID)));
    mutations["escrow.prepareDispute"] = prepare;
    mutations["escrow.recordDispute"] = record;
    vi.mocked(submit).mockReset().mockImplementation(async (tx) => ({ hash: Buffer.from(tx.hash()).toString("hex") }) as never);
    use("buyer", RUNS.buyer);
  });

  it("checks Trustless Work's dispute in this browser, has the buyer's wallet sign it with its summary, and records it once", async () => {
    const prepared = RUNS.buyer.fixture.response.body;
    await press();

    expect(prepare.mock.calls).toEqual([[{ tradeId: ID }]]);
    // The summary reaches the wallet's own dialog (pincode, Pairy's Privy confirm), whatever the wallet kind.
    expect(signed).toEqual([{ xdr: prepared.unsignedXdr, summary: SUMMARY }]);
    // Before sending: the trade and the escrow are read again.
    expect(readEscrowOnChain).toHaveBeenCalledWith(RUNS.buyer.contractId);
    expect(vi.mocked(submit)).toHaveBeenCalledOnce();
    // Recorded once, by this step, while it still held the trade (useTradeSync leaves it alone meanwhile).
    expect(record.mock.calls).toEqual([[{ tradeId: ID, txHash: prepared.txHash }]]);
    expect(runningAtRecord).toEqual([true]);
    expect(stepRunning(ID)).toBe(false);
    // Kept as a pending dispute before sending, then cleared once recorded.
    expect(writes).toEqual([`pairy:pending-tx:${ID}`]);
    expect(store.size).toBe(0);
  });

  it("lets the seller dispute for themselves, on the seller exit's real transaction", async () => {
    use("seller", RUNS.seller);
    await press();
    expect(signed).toEqual([{ xdr: RUNS.seller.fixture.response.body.unsignedXdr, summary: SUMMARY }]);
    expect(record.mock.calls).toEqual([[{ tradeId: ID, txHash: RUNS.seller.fixture.response.body.txHash }]]);
  });

  it("keeps the dispute as pending while it is sent, so a reload reports it instead of disputing again", async () => {
    let kept: unknown = null;
    vi.mocked(submit).mockImplementation(async (tx) => {
      kept = JSON.parse(store.get(`pairy:pending-tx:${ID}`) ?? "null");
      return { hash: Buffer.from(tx.hash()).toString("hex") } as never;
    });
    await press();
    expect(kept).toMatchObject({ kind: "dispute", hash: RUNS.buyer.fixture.response.body.txHash });
  });

  it("treats a dispute the background sync recorded first as recorded", async () => {
    const hash = RUNS.buyer.fixture.response.body.txHash;
    record.mockImplementationOnce(async () => {
      // The sync got there first: Pairy now has this very dispute.
      now.trade = { ...tradeOf("buyer"), disputed: true, disputeTx: hash };
      throw new Error("This trade's dispute is already recorded.");
    });
    await press();
    expect(record).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });

  it("keeps the hash for a retry when Pairy could not record it and nothing else did", async () => {
    record.mockRejectedValueOnce(new Error("fetch failed"));
    await press();
    expect(vi.mocked(submit)).toHaveBeenCalledOnce();
    expect(JSON.parse(store.get(`pairy:pending-tx:${ID}`)!)).toMatchObject({ kind: "dispute", hash: RUNS.buyer.fixture.response.body.txHash });
  });

  it("sends nothing when the trader refuses in the wallet", async () => {
    (wallet.result.wallet as { signTransaction: unknown }).signTransaction = vi.fn(async () => {
      throw new Error("The user declined the request.");
    });
    await press();
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("asks no wallet when Pairy refuses to prepare it, e.g. a dispute already on chain", async () => {
    prepare.mockRejectedValueOnce(new Error("This trade already has a dispute on chain; refresh the trade."));
    await press();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
  });

  it("never signs, sends or stores a dispute whose on-chain reason Trustless Work changed and re-hashed", async () => {
    const lying = tampered(RUNS.buyer.fixture.response.body, (args) => {
      args[1] = nativeToScVal("The seller kept the cash: Alice, +90 555 000 0000.").toXdrObject();
    });
    prepare.mockResolvedValueOnce({ ...lying, summary: SUMMARY });
    await press();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never signs Trustless Work's dispute for another escrow or another trader", async () => {
    prepare.mockResolvedValueOnce({ ...RUNS.seller.fixture.response.body, summary: SUMMARY });
    vi.setSystemTime(new Date(Date.parse(RUNS.seller.fixture.at) + 1000));
    await press();
    expect(signed).toEqual([]);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
  });

  it("never sends when a dispute or a settlement reached the escrow while the wallet was open", async () => {
    for (const status of [{ disputed: true }, { released: true, balanceStroops: 0n }, { resolved: true, balanceStroops: 0n }]) {
      vi.mocked(readEscrowOnChain).mockResolvedValue(onChain(RUNS.buyer, status));
      await press();
    }
    expect(signed).toHaveLength(3);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends when Pairy recorded a dispute meanwhile, e.g. the other trader's", async () => {
    now.trade = { ...tradeOf("buyer"), disputed: true, disputeTx: "e".repeat(64) };
    await press(tradeOf("buyer"));
    expect(signed).toHaveLength(1);
    expect(vi.mocked(submit)).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("never sends a signed dispute that is not the transaction this page checked", async () => {
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

  it("never signs with a wallet that is not this trader's", async () => {
    wallet.result = { wallet: { ...(wallet.result.wallet as object), publicKey: STRANGER }, ready: true };
    await press();
    expect(prepare).not.toHaveBeenCalled();
    expect(signed).toEqual([]);
  });
});
