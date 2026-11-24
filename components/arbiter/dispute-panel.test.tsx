import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortWhen } from "@/components/trade/format";
import { ARBITER_ACCOUNT, PLATFORM_ACCOUNT, USDC_SAC } from "@/lib/escrow/config";
import { savePendingTx, setStepRunning } from "@/lib/trade/pending-tx";

// One dispute as the arbiter sees it (D2 §7.4, FIXES F-03): every state the
// detail page can be in, from the markup it renders for one arbiter.byId
// answer. React's useEffect is captured so the pending-resolve report can be
// run by hand; every tRPC call is a stub that records its input.
const byId = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const list = vi.hoisted(() => ({ result: { data: [] as unknown[], error: null, isLoading: false } }));
const wallet = vi.hoisted(() => ({ value: { wallet: null as unknown, ready: true } }));
const mutated = vi.hoisted(() => [] as { path: string; input: unknown }[]);
const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
const depsOf = vi.hoisted(() => new Map<unknown, unknown[] | undefined>());
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown }[]);

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    effects.push(fn);
    depsOf.set(fn, deps);
  },
}));
vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useQuery") return () => (path.join(".") === "arbiter.byId" ? byId.result : list.result);
        if (key === "useMutation") {
          return () => ({
            mutateAsync: async (input: unknown) => {
              mutated.push({ path: path.join("."), input });
              return {};
            },
            isPending: false,
          });
        }
        if (key === "useUtils") return () => node([]);
        if (key === "invalidate") return async () => {};
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => wallet.value }));
vi.mock("@/components/ui/button", () => ({
  Button: (p: { children: React.ReactNode; onClick?: () => unknown; disabled?: boolean }) => {
    buttons.push({ label: String(p.children), onClick: p.onClick });
    return <button disabled={p.disabled}>{p.children}</button>;
  },
}));

const { DisputePanel, ResolutionCard, ResolutionSection } = await import("./dispute-panel");

const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
const SELLER = "GSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL1";
const BUYER = "GBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUY1";
const CONTRACT = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-12-11T12:00:00Z");
const h = (hours: number) => new Date(NOW + hours * 3600_000);
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const hash = (c: string) => c.repeat(64);

const dispute = {
  tradeId: ID,
  amount: "5.0000000",
  seller: SELLER,
  buyer: BUYER,
  contractId: CONTRACT,
  disputedAt: h(-2),
  disputeRecordedAt: h(-1.9),
  disputeOpenedBy: "buyer",
  answerDeadline: h(22.1),
  promiseDeadline: h(70),
  overdue: false,
  answers: { seller: null, buyer: null },
  ready: false,
  outcome: null,
  rule: null,
  resolution: null,
  state: "funded",
  viewerUrl: `https://viewer.trustlesswork.com/testnet/v2/${CONTRACT}`,
  escrow: {
    terms: {
      admin: "GADMIN",
      platform: PLATFORM_ACCOUNT,
      receiver: BUYER,
      approvers: [SELLER],
      releaseSigners: [SELLER],
      disputeResolvers: [ARBITER_ACCOUNT],
      serviceProviders: [SELLER],
      otherRoles: [],
      amountStroops: 50_000_000n,
      platformFeePercent: 0,
      tokenContract: USDC_SAC,
      milestones: [{ description: "Cash handed over" }],
    },
    status: { disputed: true, released: false, resolved: false, balanceStroops: 50_000_000n },
  },
  steps: [
    { step: "create", txHash: hash("c"), url: `https://stellar.expert/explorer/testnet/tx/${hash("c")}` },
    { step: "fund", txHash: hash("f"), url: `https://stellar.expert/explorer/testnet/tx/${hash("f")}` },
    { step: "dispute", txHash: hash("d"), url: `https://stellar.expert/explorer/testnet/tx/${hash("d")}` },
  ],
  notes: { seller: null, buyer: null },
  ruleSentence: null,
  feeAddress: "GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF",
};
const ready = {
  answers: { seller: false, buyer: true },
  ready: true,
  outcome: "seller",
  rule: 3,
  ruleSentence: "In every other case the seller gets the USDC back.",
};

/** The page's words, tags stripped, for assertions on what is said rather than how. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const render = (t: Record<string, unknown>, query: Record<string, unknown> = {}) => {
  byId.result = { data: { ...dispute, ...t }, error: null, isLoading: false, ...query };
  mutated.length = 0;
  effects.length = 0;
  buttons.length = 0;
  return renderToStaticMarkup(<DisputePanel tradeId={ID} me={OMER} />);
};
const runEffects = () => effects.forEach((fn) => fn());

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  wallet.value = { wallet: { kind: "freighter", publicKey: OMER, signTransaction: async () => "" }, ready: true };
  list.result = { data: [], error: null, isLoading: false };
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DisputePanel while the dispute loads or cannot be shown", () => {
  it("shows loading, the not-found sentence and the server's error", () => {
    expect(render({}, { data: undefined, isLoading: true })).toContain("Loading…");
    expect(render({}, { data: undefined, error: { message: "No dispute for the arbiter on this trade.", data: { code: "NOT_FOUND" } } })).toContain(
      "No dispute for the arbiter on this trade.",
    );
    expect(text(render({}, { data: undefined, error: { message: "Couldn't confirm the signer list. Try again.", data: { code: "FORBIDDEN" } } }))).toContain(
      "Couldn't confirm the signer list. Try again.",
    );
  });
});

describe("DisputePanel before the rule can be applied", () => {
  it("shows the escrow's terms read fresh from the chain, both addresses, every on-chain step, both answers and the answer deadline", () => {
    const html = render({ answers: { seller: null, buyer: true }, notes: { seller: null, buyer: "Paid in full at the cafe." } });
    const words = text(html);
    expect(words).toContain("5 USDC");
    expect(words).toContain("Seller GSEL…ELL1");
    expect(words).toContain("Buyer GBUY…BUY1");
    expect(words).toContain("Dispute opened by the buyer");
    // The escrow as Soroban RPC shows it now (D2 §7.4 "fresh readEscrow").
    expect(words).toContain("receiver GBUY…BUY1 · the buyer");
    expect(words).toContain("release signer GSEL…ELL1 · the seller");
    expect(words).toContain("dispute resolver GCAQ…XCPH · the arbiter");
    expect(words).toContain("holds 5 USDC · disputed");
    // Every step on chain, each linking its receipt.
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://stellar.expert/explorer/testnet/tx/${hash("c")}"[^>]*>[^<]*Create`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://stellar.expert/explorer/testnet/tx/${hash("f")}"[^>]*>[^<]*Fund`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://stellar.expert/explorer/testnet/tx/${hash("d")}"[^>]*>[^<]*Dispute`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="${dispute.viewerUrl}"`));
    // Both answers and notes; the question itself.
    expect(words).toContain("Was the cash handed over in full?");
    expect(words).toContain("Seller: no answer yet");
    expect(words).toContain("Buyer: yes");
    expect(words).toContain("Paid in full at the cafe.");
    expect(words).toContain(`Waiting for answers until ${shortWhen(dispute.answerDeadline)}`);
    expect(html).not.toMatch(/<button[^>]*>Prepare/);
    expect(words).not.toMatch(/chat/i);
  });

  it("says when the escrow could not be read, instead of inventing terms", () => {
    const words = text(render({ escrow: null }));
    expect(words).toContain("Couldn't read the escrow from Stellar testnet just now. Its terms and balance show once it answers.");
    expect(words).not.toContain("dispute resolver");
  });
});

describe("DisputePanel once the rule applies", () => {
  it("states the rule, its outcome and offers only that resolution to prepare", () => {
    const html = render(ready);
    const words = text(html);
    expect(words).toContain("In every other case the seller gets the USDC back.");
    expect(words).toContain("The rule gives: all to the seller (rule 3).");
    expect(words).toContain("Seller: no · Buyer: yes");
    expect(html).toMatch(/<button[^>]*>Prepare the resolution \(all to the seller\)<\/button>/);
    expect(words).toContain(`The arbiter signs by ${shortWhen(dispute.promiseDeadline)}`);
  });

  it("names the payee and the amount as the server reads them: the rule's party and all the escrow holds, less 0.3%", () => {
    expect(text(render(ready))).toContain(
      "Payee: the seller, GSEL…ELL1. Amount: 5 USDC, all the escrow holds; the seller receives 4.985 USDC after Trustless Work's 0.3%.",
    );
    expect(text(render({ ...ready, answers: { seller: true, buyer: true }, outcome: "buyer", rule: 1 }))).toContain(
      "Payee: the buyer, GBUY…BUY1. Amount: 5 USDC, all the escrow holds; the buyer receives 4.985 USDC after Trustless Work's 0.3%.",
    );
    // The escrow could not be read just now: the payee still shows, the amount waits for the chain.
    const words = text(render({ ...ready, escrow: null }));
    expect(words).toContain("Payee: the seller, GSEL…ELL1.");
    expect(words).not.toContain("Amount:");
  });

  it("shows the overdue promise in red", () => {
    const html = render({ ...ready, overdue: true, promiseDeadline: h(-1) });
    expect(html).toMatch(new RegExp(`<p class="[^"]*text-danger[^"]*">Overdue: the arbiter promised a resolution by ${shortWhen(h(-1))}\\.</p>`));
  });

  it("asks the Prepare press for exactly this trade's resolution", async () => {
    render(ready);
    const onClick = buttons.find((b) => b.label.startsWith("Prepare the resolution"))?.onClick;
    expect(onClick).toBeTypeOf("function");
    await onClick!();
    expect(mutated).toEqual([{ path: "arbiter.prepareResolution", input: { tradeId: ID } }]);
  });

  it("hides Prepare while another trade's resolution is being signed (FIXES F-03), naming it", () => {
    list.result = { data: [{ tradeId: OTHER_ID, resolution: { id: "r2", signers: [ENSAR], threshold: 2, expiresAt: h(0.5) } }], error: null, isLoading: false };
    const html = render(ready);
    expect(text(html)).toMatch(new RegExp(`Another resolution is being signed \\(trade ${OTHER_ID.slice(0, 8)} ?\\)\\. Finish or let it expire first\\.`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="/arbiter/${OTHER_ID}"`));
    expect(html).not.toMatch(/<button[^>]*>Prepare/);
  });

  it("offers Prepare again once that other resolution has expired", () => {
    list.result = { data: [{ tradeId: OTHER_ID, resolution: { id: "r2", signers: [ENSAR], threshold: 2, expiresAt: h(-0.1) } }], error: null, isLoading: false };
    const html = render(ready);
    expect(html).not.toContain("Another resolution is being signed");
    expect(html).toMatch(/<button[^>]*>Prepare the resolution/);
  });

  it("shows this trade's open resolution, how many signed and until when, with a way to open it for the next signer", () => {
    const expires = h(0.75);
    const html = render({ ...ready, resolution: { id: "r1", signers: [ENSAR], threshold: 2, expiresAt: expires } });
    const words = text(html);
    expect(words).toContain(`A resolution is prepared: 1 of 2 signed, valid until ${hhmm(expires)}.`);
    expect(words).toContain("Signed by GDH2…N6J7");
    expect(html).toMatch(/<button[^>]*>Open the prepared resolution<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Prepare the resolution/);
  });

  it("opens this trade's prepared resolution for the next signer through arbiter.prepareResolution, with only the trade id", async () => {
    render({ ...ready, resolution: { id: "r1", signers: [ENSAR], threshold: 2, expiresAt: h(0.75) } });
    await buttons.find((b) => b.label === "Open the prepared resolution")!.onClick!();
    expect(mutated).toEqual([{ path: "arbiter.prepareResolution", input: { tradeId: ID } }]);
  });

  it("tells a signer who already signed to wait for the other", () => {
    const html = render({ ...ready, resolution: { id: "r1", signers: [OMER], threshold: 2, expiresAt: h(0.75) } });
    expect(text(html)).toContain("You signed. Waiting for the other signer; this page updates when the resolution lands.");
    expect(html).not.toMatch(/<button[^>]*>(Open the prepared resolution|Prepare the resolution|Sign as)/);
  });

  it("says a resolution that expired unsigned must be prepared again", () => {
    const expired = h(-0.1);
    const html = render({ ...ready, resolution: { id: "r1", signers: [ENSAR], threshold: 2, expiresAt: expired } });
    expect(text(html)).toContain(`This prepared transaction expired at ${shortWhen(expired)}. Prepare again.`);
    expect(html).toMatch(/<button[^>]*>Prepare the resolution/);
  });

  it("keeps the page for a signer without Freighter and says how to sign (O-30)", () => {
    wallet.value = { wallet: { kind: "device", publicKey: OMER, signTransaction: async () => "" }, ready: true };
    const words = text(render({ ...ready, resolution: { id: "r1", signers: [ENSAR], threshold: 2, expiresAt: h(0.75) } }));
    expect(words).toContain("Sign with Varial (formerly Freighter) on your own computer.");
    expect(words).toContain("A resolution is prepared");
  });
});

describe("DisputePanel after the resolution landed", () => {
  it("shows the outcome and the receipt, and nothing to prepare or sign", () => {
    const html = render({
      ...ready,
      state: "resolved_seller",
      steps: [...dispute.steps, { step: "resolve", txHash: hash("e"), url: `https://stellar.expert/explorer/testnet/tx/${hash("e")}` }],
    });
    expect(text(html)).toContain("Resolved: all to the seller, less Trustless Work's 0.3%.");
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://stellar.expert/explorer/testnet/tx/${hash("e")}"[^>]*>Receipt`));
    expect(html).not.toMatch(/<button/);
  });
});

describe("DisputePanel and a resolve this browser sent but never got recorded (pending-tx resolve)", () => {
  it("reports the kept hash through arbiter.recordResolution on load, then drops it", async () => {
    savePendingTx(ID, { kind: "resolve", hash: hash("e") });
    const html = render(ready);
    expect(text(html)).toContain("A resolution was sent from this browser. Recording it once Stellar testnet shows it…");
    runEffects();
    await vi.advanceTimersByTimeAsync(0);
    expect(mutated).toEqual([{ path: "arbiter.recordResolution", input: { tradeId: ID, txHash: hash("e") } }]);
    expect(localStorage.getItem(`pairy:pending-tx:${ID}`)).toBeNull();
  });

  it("leaves the kept hash to the step while this page is sending and recording it: one record, not two (WP-35)", async () => {
    savePendingTx(ID, { kind: "resolve", hash: hash("e") });
    setStepRunning(ID, true);
    try {
      render(ready);
      runEffects();
      await vi.advanceTimersByTimeAsync(0);
      expect(mutated).toEqual([]);
      expect(localStorage.getItem(`pairy:pending-tx:${ID}`)).not.toBeNull();
    } finally {
      setStepRunning(ID, false);
    }
  });

  it("tries the kept hash again on every refetch of the dispute until it is recorded, as useTradeSync's tick does", () => {
    savePendingTx(ID, { kind: "resolve", hash: hash("e") });
    // The report is the panel's last effect; React re-runs it when its deps change, so the refetch time must be one of them
    // (after a "may still go through" send nothing else changes until the resolve lands).
    render(ready, { dataUpdatedAt: 1_765_454_400_123 });
    expect(depsOf.get(effects.at(-1)!)).toContain(1_765_454_400_123);
  });

  it("drops a kept hash once the trade shows its resolve, without reporting it", () => {
    savePendingTx(ID, { kind: "resolve", hash: hash("e") });
    const html = render({ ...ready, state: "resolved_seller", steps: [...dispute.steps, { step: "resolve", txHash: hash("e"), url: "" }] });
    expect(text(html)).not.toContain("Recording it");
    runEffects();
    expect(mutated).toEqual([]);
    expect(localStorage.getItem(`pairy:pending-tx:${ID}`)).toBeNull();
  });
});

describe("ResolutionCard: one prepared resolution, ready to sign", () => {
  const expires = h(0.9);
  const prepared = {
    resolutionId: "r1",
    unsignedXdr: "AAAA",
    txHash: hash("a"),
    summary: "Pay this trade's escrow to GSEL…ELL1: 4.985 USDC after Trustless Work's 0.3% fee",
    expiresAt: expires,
    threshold: 2,
    signers: [] as string[],
  };
  const check = { problems: [] as string[], summary: prepared.summary };
  const card = (p: Partial<Parameters<typeof ResolutionCard>[0]> = {}) => {
    buttons.length = 0;
    return renderToStaticMarkup(
      <ResolutionCard prepared={prepared} check={check} me={OMER} signerProblem={null} now={NOW} busy={false} onSign={() => {}} notice={null} {...p} />,
    );
  };

  it("shows the hash, what will be signed, the validity and what happens when it runs out, and the Sign button", () => {
    const html = card();
    const words = text(html);
    expect(words).toContain(hash("a"));
    expect(words).toContain(`What you will sign: ${prepared.summary}`);
    const signUntil = hhmm(new Date(expires.getTime() - 10 * 60_000));
    expect(words).toContain(`Valid until ${hhmm(expires)}; signatures are taken until ${signUntil} (about 44 minutes left), the last ten minutes are for sending.`);
    expect(words).toContain("When it runs out nothing has been sent and no fee is paid: prepare again.");
    expect(words).toContain("0 of 2 signed");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Sign as GDRJ…LD5Q<\/button>/);
  });

  it("disables Sign and says why for a wallet that cannot sign", () => {
    const html = card({ signerProblem: "Sign with Varial (formerly Freighter) on your own computer." });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sign as GDRJ…LD5Q<\/button>/);
    expect(text(html)).toContain("Sign with Varial (formerly Freighter) on your own computer.");
  });

  it("refuses to sign what the browser's check refused, verbatim", () => {
    const html = card({ check: { problems: ["It pays out 1 to GX, not 2 to GY."], summary: "" } });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sign as/);
    expect(text(html)).toContain("This browser won't sign it: It pays out 1 to GX, not 2 to GY.");
    expect(text(html)).not.toContain("What you will sign");
  });

  it("replaces Sign with the expired sentence once the window has run out", () => {
    const html = card({ now: expires.getTime() });
    expect(text(html)).toContain(`This prepared transaction expired at ${shortWhen(expires)}. Prepare again.`);
    expect(html).not.toMatch(/<button[^>]*>Sign as/);
  });

  it("shows who signed, marks my own signature and does not offer to sign twice", () => {
    const html = card({ prepared: { ...prepared, signers: [OMER] } });
    expect(text(html)).toContain("1 of 2 signed");
    expect(text(html)).toContain("Signed by GDRJ…LD5Q (you)");
    expect(html).not.toMatch(/<button[^>]*>Sign as/);
  });

  it("shows the handoff sentence after a signature that was not the last, and the busy label while signing", () => {
    expect(text(card({ notice: "1 of 2. Ask the other signer to open this page.", prepared: { ...prepared, signers: [OMER] } }))).toContain(
      "1 of 2. Ask the other signer to open this page.",
    );
    expect(card({ busy: true })).toMatch(/<button[^>]*disabled[^>]*>Signing…<\/button>/);
  });
});

describe("ResolutionSection: the resolution part of the page, for each state the signing leaves it in (D2 §7.4, FIXES F-03)", () => {
  const step = { busy: false, error: null as string | null, unreported: null as string | null, run: async () => {}, retry: async () => {} };
  const held = {
    resolutionId: "r1",
    unsignedXdr: "AAAA",
    txHash: hash("a"),
    summary: "",
    expiresAt: h(0.9),
    threshold: 2,
    signers: [] as string[],
  };
  const section = (p: Partial<Parameters<typeof ResolutionSection>[0]> = {}) => {
    buttons.length = 0;
    return renderToStaticMarkup(
      <ResolutionSection
        dispute={{ ...dispute, ...ready } as never}
        me={OMER}
        now={NOW}
        held={null}
        other={null}
        signerProblem={null}
        busy={false}
        recovering={false}
        refused={false}
        failure={null}
        notice={null}
        step={step as never}
        onPrepare={() => {}}
        onSign={() => {}}
        {...p}
      />,
    );
  };
  const prepareButton = () => buttons.find((b) => b.label.startsWith("Prepare the resolution"));

  it("after this browser's send was refused by the network, says so in F-03's words and offers Prepare again", () => {
    const html = section({ held: { ...held, signers: [ENSAR, OMER] }, refused: true, step: { ...step, error: "The account's sequence number changed before submission. Try again. (tx_bad_seq)" } as never });
    const words = text(html);
    expect(words).toContain("This prepared transaction was not accepted by the network; prepare again.");
    expect(words).toContain("(tx_bad_seq)");
    expect(prepareButton()).toBeDefined();
    expect(html).not.toMatch(/<button[^>]*>Sign as/);
  });

  it("shows the server's refusals verbatim: the arbiter account moved on, a failed resolution, and a signer removed mid-collection (WP-29 N3)", () => {
    for (const failure of [
      "The arbiter account moved on; prepare again.",
      "This prepared transaction was not accepted by the network; prepare again.",
      `A signature on this transaction is not from one of the arbiter's signers. A signer was removed from the arbiter account while this resolution was being signed; prepare again after it expires at ${shortWhen(h(0.9))}.`,
    ]) {
      const html = section({ failure });
      expect(html).toMatch(/<p role="alert"/);
      expect(text(html)).toContain(failure);
      expect(prepareButton()).toBeDefined();
    }
  });

  it("tells the next signer when the resolution they opened was replaced: every signer signs the new one", () => {
    const notice = "The earlier prepared transaction could no longer land (the arbiter account moved on), so this is a new one: every signer signs it.";
    expect(text(section({ held, notice }))).toContain(notice);
  });

  it("holds a prepared resolution: its card, with Sign for this signer", () => {
    const html = section({ held: { ...held, summary: "Pay this trade's escrow to GSEL…ELL1: 4.985 USDC after Trustless Work's 0.3% fee" } });
    expect(text(html)).toContain(hash("a"));
    expect(html).toMatch(/<button[^>]*>Sign as GDRJ…LD5Q<\/button>/);
    expect(prepareButton()).toBeUndefined();
  });

  it("after this signer's own signature, shows 1 of 2 with them named and no second Sign", () => {
    const html = section({ held: { ...held, signers: [OMER] }, notice: "1 of 2. Ask the other signer to open this page." });
    const words = text(html);
    expect(words).toContain("1 of 2 signed · Signed by GDRJ…LD5Q (you)");
    expect(words).toContain("1 of 2. Ask the other signer to open this page.");
    expect(html).not.toMatch(/<button[^>]*>Sign as/);
  });

  it("while a resolve this browser sent is being recorded, offers nothing to prepare or sign", () => {
    const html = section({ held: { ...held, signers: [ENSAR, OMER] }, recovering: true });
    expect(text(html)).toContain("A resolution was sent from this browser. Recording it once Stellar testnet shows it…");
    expect(html).not.toMatch(/<button/);
  });

  it("when every signature is in but the resolve has not landed, says who sends it and lets a signer prepare again if it never does", () => {
    const html = section({ dispute: { ...dispute, ...ready, resolution: { id: "r1", signers: [ENSAR, OMER], threshold: 2, expiresAt: h(0.5) } } as never });
    expect(text(html)).toContain(
      "All 2 signatures are in. The last signer's browser sends it, and this page updates once it lands. If it never does, prepare again.",
    );
    expect(prepareButton()).toBeDefined();
  });

  it("names the trade whose resolution is being signed and offers no Prepare (FIXES F-03)", () => {
    const html = section({ other: OTHER_ID });
    expect(text(html)).toMatch(new RegExp(`Another resolution is being signed \\(trade ${OTHER_ID.slice(0, 8)} ?\\)\\. Finish or let it expire first\\.`));
    expect(prepareButton()).toBeUndefined();
  });
});
