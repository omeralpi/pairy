import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortWhen } from "@/components/trade/format";

// The arbiter's list of open disputes (D2 §7.4) as it renders for one
// arbiter.list answer: the order, what each row says, and the empty state.
const list = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const wallet = vi.hoisted(() => ({ value: { wallet: null as unknown, ready: true } }));

vi.mock("@/lib/api", () => ({
  api: { arbiter: { list: { useQuery: () => list.result } } },
}));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => wallet.value }));

const { ArbiterList } = await import("./arbiter-list");

const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
const NOW = Date.parse("2026-12-11T12:00:00Z");
const h = (hours: number) => new Date(NOW + hours * 3600_000);

let n = 0;
const row = (t: Record<string, unknown>) => {
  const disputedAt = (t.disputedAt as Date) ?? h(-2);
  return {
    tradeId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    amount: "10.0000000",
    seller: "GSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL1",
    buyer: "GBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUYERBUY1",
    contractId: "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34",
    disputedAt,
    disputeRecordedAt: disputedAt,
    disputeOpenedBy: "buyer",
    answerDeadline: new Date(disputedAt.getTime() + 24 * 3600_000),
    promiseDeadline: new Date(disputedAt.getTime() + 72 * 3600_000),
    overdue: false,
    answers: { seller: null, buyer: null },
    ready: false,
    outcome: null,
    rule: null,
    resolution: null,
    ...t,
  };
};
const render = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  list.result = { data: rows, error: null, isLoading: false, ...extra };
  return renderToStaticMarkup(<ArbiterList me={OMER} threshold={2} />);
};
const items = (html: string) => [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  wallet.value = { wallet: { kind: "freighter", publicKey: OMER, signTransaction: async () => "" }, ready: true };
});
afterEach(() => vi.useRealTimers());

describe("ArbiterList", () => {
  it("says so when there is no open dispute", () => {
    expect(render([])).toContain("No open disputes.");
  });

  it("shows loading and the server's error sentence", () => {
    expect(render([], { data: undefined, isLoading: true })).toContain("Loading…");
    expect(render([], { data: undefined, error: { message: "Couldn't confirm the signer list. Try again.", data: { code: "FORBIDDEN" } } })).toContain(
      "Couldn&#x27;t confirm the signer list. Try again.",
    );
  });

  it("sorts the rows by the arbiter's promise deadline, the earliest first, and marks an overdue one in red", () => {
    const late = row({ disputedAt: h(-80), overdue: true, ready: true, outcome: "seller", rule: 3, answers: { seller: false, buyer: true } });
    const soon = row({ disputedAt: h(-70) });
    const fresh = row({ disputedAt: h(-1) });
    const html = render([fresh, soon, late]);
    const rows = items(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(`href="/arbiter/${late.tradeId}"`);
    expect(rows[1]).toContain(`href="/arbiter/${soon.tradeId}"`);
    expect(rows[2]).toContain(`href="/arbiter/${fresh.tradeId}"`);
    expect(rows[0]).toMatch(new RegExp(`<p class="[^"]*text-danger[^"]*">Overdue: promised by ${shortWhen(late.promiseDeadline)}</p>`));
    expect(rows[1]).toContain(`Resolve by ${shortWhen(soon.promiseDeadline)}`);
    expect(rows[1]).not.toContain("text-danger");
  });

  it("says what each dispute is waiting for: the answers, or the rule's outcome once both are in or the window closed", () => {
    const waiting = row({ answers: { seller: null, buyer: true } });
    const ready = row({ ready: true, outcome: "buyer", rule: 1, answers: { seller: true, buyer: true } });
    const html = render([waiting, ready]);
    const [w, r] = items(html);
    expect(w).toContain(`Waiting for answers until ${shortWhen(waiting.answerDeadline)}`);
    expect(w).toContain("Seller: no answer yet · Buyer: yes");
    expect(r).toContain("Ready: all to the buyer (rule 1)");
    expect(r).toContain("Seller: yes · Buyer: yes");
    expect(html).toContain("10 USDC");
    expect(html).toContain("GSEL…ELL1 → GBUY…BUY1");
    expect(html).toContain(`Dispute opened by the buyer, ${shortWhen(waiting.disputedAt)}`);
  });

  it("shows how far an open resolution has got and until when it is valid (O-17)", () => {
    const expires = h(0.75);
    const hhmm = expires.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const html = render([row({ ready: true, outcome: "seller", rule: 3, answers: { seller: false, buyer: false }, resolution: { id: "r1", signers: [ENSAR], threshold: 2, expiresAt: expires } })]);
    expect(html).toContain(`1 of 2 signed · valid until ${hhmm}`);
  });

  it("names an open resolution that already expired", () => {
    const html = render([row({ ready: true, outcome: "seller", rule: 3, resolution: { id: "r1", signers: [], threshold: 2, expiresAt: h(-0.1) } })]);
    expect(html).toContain("0 of 2 signed · expired; prepare again");
  });

  it("keeps the list visible for a signer without Freighter, and says how to sign (SOW acceptance item 2, O-30)", () => {
    wallet.value = { wallet: { kind: "device", publicKey: OMER, signTransaction: async () => "" }, ready: true };
    const html = render([row({})]);
    expect(items(html)).toHaveLength(1);
    expect(html).toContain("Sign with Varial (formerly Freighter) on your own computer.");
    wallet.value = { wallet: { kind: "freighter", publicKey: OMER, signTransaction: async () => "" }, ready: true };
    expect(render([row({})])).not.toContain("Varial");
  });

  it("shows no chat and no note", () => {
    const html = render([row({ ready: true, outcome: "buyer", rule: 1, answers: { seller: true, buyer: true } })]);
    expect(html).not.toMatch(/chat|note/i);
  });
});
