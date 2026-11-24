import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { explorerTxUrl } from "@/lib/stellar/horizon";

import { EscrowProof } from "./escrow-proof";

// "How this is enforced" for a protected trade of 10 USDC, as the seller sees it.
const contract = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const admin = "GA4YXFZ6QJ7R3A6OJ5Q7G3W2K4XQFN6Y3H2T5B3Q7W2K4XQFN6Y3ZPRP";
const base = {
  state: "agreed",
  role: "seller",
  seller: "GSELLER",
  buyer: "GBUYER",
  asset: "USDC",
  amount: "10.0000000",
  disputed: false,
  escrowContractId: null,
  escrowAdmin: null,
  createTx: null,
  fundTx: null,
  disputeTx: null,
  releaseTx: null,
  resolveTx: null,
  viewerUrl: null,
};
const created = {
  ...base,
  state: "escrow_created",
  escrowContractId: contract,
  escrowAdmin: admin,
  createTx: "c".repeat(64),
  viewerUrl: `https://viewer.trustlesswork.com/testnet/v2/${contract}`,
};
const render = (t: Record<string, unknown>) => renderToStaticMarkup(<EscrowProof trade={{ ...base, ...t } as never} />);

describe("EscrowProof", () => {
  it("is the collapsed technical record, and never describes a claimable balance", () => {
    const html = render({});
    expect(html).toMatch(/<details[^>]*>.*<summary[^>]*>.*How this is enforced/s);
    expect(html).not.toMatch(/claimable balance|CAP-23|BEFORE_RELATIVE_TIME|claim/i);
  });

  it("says what the escrow is and who can move it: the arbiter is the Pairy team, and Pairy's server holds no key (O-41)", () => {
    const html = render({});
    expect(html).toContain("Trustless Work escrow");
    expect(html).toContain("That account is the Pairy team&#x27;s, and both builders must sign. Pairy&#x27;s server holds no key to it and signs nothing.");
    expect(html).not.toContain("Pairy holds no key, is not a signer and cannot move it.");
    expect(html).toContain("Only the seller can release it, and only the arbiter account can resolve a dispute");
  });

  it("says no escrow exists yet before the create is recorded, with no contract or receipts", () => {
    const html = render({});
    expect(html).toContain("No escrow exists yet.");
    expect(html).not.toContain("viewer.trustlesswork.com");
    expect(html).not.toMatch(/(Create|Fund|Dispute|Release|Resolve) receipt/);
  });

  it("links the contract on Trustless Work's viewer and lists its roles once it exists", () => {
    const html = render(created);
    expect(html).not.toContain("No escrow exists yet.");
    expect(html).toContain(`href="https://viewer.trustlesswork.com/testnet/v2/${contract}"`);
    expect(html).toContain("CDQO…QO34");
    expect(html).toContain("GSEL…LLER");
    expect(html).toContain("GBUY…UYER");
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/account/${ARBITER_ACCOUNT}"`);
    expect(html).toContain("GA4Y…ZPRP");
  });

  // The escrow's amount is a term of the contract; who it pays, and whether it has paid, depends on the state.
  const funded = { ...created, state: "funded", fundTx: "f".repeat(64) };
  const payoutRows = (html: string) =>
    [...html.matchAll(/<dt>([^<]*)<\/dt><dd class="text-ink">([^<]*)<\/dd>/g)].map((m) => `${m[1]} · ${m[2].replaceAll("&#x27;", "'")}`);

  it("states the amount as a term and never claims the escrow holds a balance", () => {
    for (const t of [created, funded, { ...funded, state: "released", releaseTx: "r".repeat(64) }, { ...created, state: "cancelled" }]) {
      const html = render(t);
      expect(html).toContain("amount</dt>");
      expect(html).toContain("10 USDC");
      expect(html).not.toMatch(/<dt>holds/);
    }
  });

  it("says who a release would pay before the escrow is funded, and once it is", () => {
    expect(payoutRows(render(created))).toContain("pays on release · 9.97 USDC to the buyer, once it is funded");
    expect(render(created)).not.toContain("paid");
    const rows = payoutRows(render(funded));
    expect(rows).toContain("pays on release · 9.97 USDC to the buyer");
    expect(rows).toContain("in a dispute · the arbiter pays 9.97 USDC to the buyer or the seller, by the rule");
    expect(render(funded)).not.toContain("paid");
  });

  it("leaves only the arbiter's payout once a dispute is open", () => {
    const rows = payoutRows(render({ ...funded, disputed: true, disputeTx: "d".repeat(64) }));
    expect(rows).toContain("the arbiter pays · 9.97 USDC to the buyer or the seller, by the rule");
    expect(rows.some((r) => r.startsWith("pays on release"))).toBe(false);
  });

  it("names who was paid after a release or a resolution, and never contradicts the status line", () => {
    const released = render({ ...funded, state: "released", releaseTx: "r".repeat(64) });
    expect(payoutRows(released)).toContain("paid · 9.97 USDC to the buyer, after Trustless Work's 0.3%");
    expect(released).not.toMatch(/pays on release|in a dispute/);
    const toBuyer = render({ ...funded, state: "resolved_buyer", disputed: true, disputeTx: "d".repeat(64), resolveTx: "e".repeat(64) });
    expect(payoutRows(toBuyer)).toContain("paid by the arbiter · 9.97 USDC to the buyer, after Trustless Work's 0.3%");
    const toSeller = render({ ...funded, state: "resolved_seller", disputed: true, disputeTx: "d".repeat(64), resolveTx: "e".repeat(64) });
    expect(payoutRows(toSeller)).toContain("paid by the arbiter · 9.97 USDC to the seller, after Trustless Work's 0.3%");
    expect(toSeller).not.toContain("to the buyer");
  });

  it("promises no payout on a cancelled trade, and no future escrow when none was created", () => {
    const afterCreate = render({ ...created, state: "cancelled" });
    expect(afterCreate).not.toMatch(/pays on release|in a dispute|paid|Once the seller creates it/);
    expect(afterCreate).toContain(`href="https://viewer.trustlesswork.com/testnet/v2/${contract}"`);
    const noEscrow = render({ state: "cancelled" });
    expect(noEscrow).toContain("No escrow was created.");
    expect(noEscrow).not.toMatch(/No escrow exists yet|Once the seller creates it|pays|paid/);
  });

  // WP-30's trade-room fixture has no escrow columns at all.
  it("treats missing escrow columns as no escrow, without throwing", () => {
    const { escrowContractId: _c, escrowAdmin: _a, createTx: _t, fundTx: _f, disputeTx: _d, releaseTx: _r, resolveTx: _e, viewerUrl: _v, ...bare } = base;
    const html = renderToStaticMarkup(<EscrowProof trade={bare as never} />);
    expect(html).toContain("No escrow exists yet.");
    expect(html).not.toContain("viewer.trustlesswork.com");
  });

  it("links the published rule and the viewer so anyone can check it", () => {
    const html = render(created);
    expect(html).toContain('href="https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md"');
    expect(html).toContain("24 hours");
    expect(html).toContain("72 hours");
  });

  it("lists one receipt per recorded transaction, in order, each linking its own hash", () => {
    const tx = { createTx: "1".repeat(64), fundTx: "2".repeat(64), disputeTx: "3".repeat(64), releaseTx: "4".repeat(64), resolveTx: "5".repeat(64) };
    const receiptLinks = (html: string) =>
      [...html.matchAll(/(Create|Fund|Dispute|Release|Resolve) receipt · <a href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(receiptLinks(render({ ...created, ...tx, releaseTx: null, state: "resolved_buyer", disputed: true }))).toEqual([
      ["Create", explorerTxUrl(tx.createTx)],
      ["Fund", explorerTxUrl(tx.fundTx)],
      ["Dispute", explorerTxUrl(tx.disputeTx)],
      ["Resolve", explorerTxUrl(tx.resolveTx)],
    ]);
    expect(receiptLinks(render({ ...created, ...tx, disputeTx: null, resolveTx: null, state: "released" }))).toEqual([
      ["Create", explorerTxUrl(tx.createTx)],
      ["Fund", explorerTxUrl(tx.fundTx)],
      ["Release", explorerTxUrl(tx.releaseTx)],
    ]);
  });

  it("opens every outside link in a new tab without a referrer", () => {
    const html = render({ ...created, fundTx: "f".repeat(64) });
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noreferrer"');
    }
  });
});
