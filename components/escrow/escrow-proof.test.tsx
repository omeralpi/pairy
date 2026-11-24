import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";

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

  it("says what the escrow is and who can move it, with Pairy holding no key", () => {
    const html = render({});
    expect(html).toContain("Trustless Work escrow");
    expect(html).toContain("Pairy holds no key, is not a signer and cannot move it.");
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
    expect(html).toContain("10 USDC");
    expect(html).toContain("9.97 USDC");
  });

  it("links the published rule and the viewer so anyone can check it", () => {
    const html = render(created);
    expect(html).toContain('href="https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md"');
    expect(html).toContain("24 hours");
    expect(html).toContain("72 hours");
  });

  it("lists one receipt per recorded transaction, in order", () => {
    const html = render({
      ...created,
      state: "resolved_buyer",
      disputed: true,
      fundTx: "f".repeat(64),
      disputeTx: "d".repeat(64),
      resolveTx: "e".repeat(64),
    });
    const receipts = [...html.matchAll(/(Create|Fund|Dispute|Release|Resolve) receipt/g)].map((m) => m[1]);
    expect(receipts).toEqual(["Create", "Fund", "Dispute", "Resolve"]);
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${"e".repeat(64)}"`);
    expect(render({ ...created, state: "released", fundTx: "f".repeat(64), releaseTx: "r".repeat(64) })).toMatch(
      /Create receipt.*Fund receipt.*Release receipt/s,
    );
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
