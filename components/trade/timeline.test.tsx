import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Timeline } from "./timeline";

// The timeline of a protected trade of 10 USDC, seen by the seller.
const at = new Date("2026-12-01T10:00:00Z");
const event = (type: string, by: string, txHash: string | null = null) => ({
  id: `${type}-${by}`,
  tradeId: "t",
  type,
  by,
  txHash,
  createdAt: at,
  txUrl: txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null,
});
const trade = {
  role: "seller",
  asset: "USDC",
  amount: "10.0000000",
  mode: "protected",
  state: "funded",
  events: [] as ReturnType<typeof event>[],
};
const render = (events: ReturnType<typeof event>[], t: Partial<typeof trade> = {}) =>
  renderToStaticMarkup(<Timeline trade={{ ...trade, ...t, events } as never} />);
const lines = (html: string) =>
  [...html.matchAll(/<p class="text-sm text-ink">([^<]*)<\/p>/g)].map((m) => m[1].replaceAll("&#x27;", "'"));

describe("Timeline sentences in a protected trade", () => {
  it("says both sides accepted the protected-trade terms when they opened and agreed", () => {
    expect(lines(render([event("open", "buyer"), event("agree", "seller")]))).toEqual([
      "The buyer opened the trade and accepted the protected-trade terms.",
      "You agreed and accepted the protected-trade terms.",
    ]);
    expect(lines(render([event("open", "seller")]))).toEqual(["You opened the trade and accepted the protected-trade terms."]);
  });

  it("keeps the plain open and agree sentences for a claimable trade", () => {
    expect(lines(render([event("open", "buyer"), event("agree", "seller")], { mode: "claimable", asset: "XLM" }))).toEqual([
      "The buyer opened the trade.",
      "You agreed.",
    ]);
  });

  it("describes each escrow step with its receipt", () => {
    const html = render([
      event("escrowCreate", "seller", "c".repeat(64)),
      event("fund", "seller", "f".repeat(64)),
      event("release", "seller", "r".repeat(64)),
    ]);
    expect(lines(html)).toEqual([
      "You created the escrow.",
      "You funded the escrow with 10 USDC.",
      "You released the escrow to the buyer, less Trustless Work's 0.3%.",
    ]);
    expect(html.match(/Receipt ↗/g)).toHaveLength(3);
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${"f".repeat(64)}"`);
  });

  it("describes the dispute, both answers and the arbiter's resolution from the viewer's side", () => {
    const html = render(
      [
        event("escrowDispute", "buyer", "d".repeat(64)),
        event("answerNo", "seller"),
        event("answerYes", "buyer"),
        event("resolve", "arbiter", "e".repeat(64)),
      ],
      { state: "resolved_buyer" },
    );
    expect(lines(html)).toEqual([
      "The buyer opened a dispute on the escrow.",
      "You answered: the cash was not handed over in full.",
      "The buyer answered: the cash was handed over in full.",
      "The arbiter settled the dispute: all to the buyer, less 0.3%.",
    ]);
  });

  it("names the seller as the arbiter's outcome too, and the buyer's own answer as yours", () => {
    const html = render([event("escrowDispute", "seller", "d".repeat(64)), event("answerYes", "buyer"), event("resolve", "arbiter", "e".repeat(64))], {
      role: "buyer",
      state: "resolved_seller",
    });
    expect(lines(html)).toEqual([
      "The seller opened a dispute on the escrow.",
      "You answered: the cash was handed over in full.",
      "The arbiter settled the dispute: all to the seller, less 0.3%.",
    ]);
  });

  it("never falls back to the raw event name for a protected event", () => {
    const types = ["escrowCreate", "fund", "release", "escrowDispute", "answerYes", "answerNo"];
    const html = render(types.map((t) => event(t, "seller")));
    for (const t of types) expect(html).not.toContain(`: ${t}.`);
  });

  it("keeps the claimable sentences", () => {
    expect(lines(render([event("lock", "seller", "l".repeat(64)), event("claim", "buyer", "k".repeat(64))], { mode: "claimable", asset: "XLM" }))).toEqual([
      "You locked the XLM.",
      "The buyer claimed the XLM.",
    ]);
  });
});
