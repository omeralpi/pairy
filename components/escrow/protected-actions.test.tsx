import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ACCEPTANCE_TITLE, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";

// What a protected trade's room offers, by role and state. Every query and
// mutation is a stub; the queries it asks for are recorded. `accepted` is the
// only state that starts at false, so swapping it shows the ticked box.
const preflight = vi.hoisted(() => ({ data: undefined as unknown }));
const queries = vi.hoisted(() => [] as { path: string; enabled: unknown }[]);
const mutated = vi.hoisted(() => [] as { path: string; input: unknown }[]);
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown }[]);
const initial = vi.hoisted(() => ({ accepted: false }));
const mutationOpts = vi.hoisted(() => ({}) as Record<string, { onError?: (e: unknown) => void }>);
const confirms = vi.hoisted(() => [] as { description: string; onConfirm: () => void }[]);
const toasts = vi.hoisted(() => [] as string[]);

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (v: unknown) => react.useState(v === false ? initial.accepted : v) };
});
vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useQuery") {
          return (_input: unknown, opts?: { enabled?: unknown }) => {
            queries.push({ path: path.join("."), enabled: opts?.enabled ?? true });
            return path.join(".") === "escrow.preflight" ? { data: preflight.data } : { data: undefined };
          };
        }
        if (key === "useMutation") {
          return (opts?: { onError?: (e: unknown) => void }) => {
            mutationOpts[path.join(".")] = opts ?? {};
            return { mutate: (input: unknown) => void mutated.push({ path: path.join("."), input }), isPending: false };
          };
        }
        if (key === "useUtils") return () => node([]);
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});
vi.mock("@/components/confirm-action", () => ({
  ConfirmAction: ({ children, description, onConfirm }: { children: React.ReactNode; description: string; onConfirm: () => void }) => {
    confirms.push({ description, onConfirm });
    return <div data-confirm={description}>{children}</div>;
  },
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => void toasts.push(m) } }));
vi.mock("@/components/ui/button", () => ({
  Button: (p: { children: string; onClick?: () => unknown; disabled?: boolean }) => {
    buttons.push({ label: String(p.children), onClick: p.onClick });
    return <button disabled={p.disabled}>{p.children}</button>;
  },
}));
vi.mock("@/components/escrow/create-panel", () => ({ CreatePanel: () => <p>CREATE PANEL</p> }));
vi.mock("@/components/escrow/fund-panel", () => ({ FundPanel: () => <p>FUND PANEL</p> }));
vi.mock("@/components/escrow/release-panel", () => ({ ReleasePanel: () => <p>RELEASE PANEL</p> }));
vi.mock("@/components/trade/trustline-button", () => ({
  TrustlineButton: (p: { asset: string; escrow?: boolean }) => <p>TRUSTLINE {p.asset} {p.escrow ? "before the escrow" : ""}</p>,
}));

const { ProtectedActions } = await import("./protected-actions");

const trade = {
  id: "11111111-1111-4111-8111-111111111111",
  mode: "protected",
  state: "listed",
  role: "seller",
  openedBy: "buyer",
  seller: "GSELLER",
  buyer: "GBUYER",
  asset: "USDC",
  amount: "20.0000000",
};
const render = (t: Partial<typeof trade>, o: { accepted?: boolean; trustline?: boolean; account?: boolean } = {}) => {
  initial.accepted = o.accepted ?? false;
  preflight.data = {
    checks:
      o.account === false ? [{ id: "buyerAccount", ok: false }] : [{ id: "buyerAccount", ok: true }, { id: "buyerTrustline", ok: o.trustline ?? true }],
  };
  queries.length = 0;
  buttons.length = 0;
  mutated.length = 0;
  confirms.length = 0;
  toasts.length = 0;
  return renderToStaticMarkup(<ProtectedActions trade={{ ...trade, ...t } as never} />);
};
const agreeButton = (html: string) => html.match(/<button[^>]*>Agree and accept<\/button>/)?.[0];

describe("ProtectedActions while the trade is listed", () => {
  it("shows the peer who did not open it the acceptance screen, with Agree and accept off until I accept", () => {
    const html = render({ role: "seller", openedBy: "buyer" });
    expect(html).toContain("The buyer proposed a protected trade.");
    expect(html).toContain(ACCEPTANCE_TITLE);
    expect(agreeButton(html)).toContain('disabled=""');
    expect(html).not.toContain("Agree to trade");
    expect(html).toContain("Cancel trade");
  });

  it("turns Agree and accept on once I accept", () => {
    const button = agreeButton(render({ role: "seller", openedBy: "buyer" }, { accepted: true }));
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
  });

  it("agrees with the acceptance text's version, which the server checks against the trade's (WP-30 N1)", () => {
    render({ role: "seller", openedBy: "buyer" }, { accepted: true });
    buttons.find((b) => b.label === "Agree and accept")!.onClick!();
    expect(mutated).toEqual([{ path: "trade.agree", input: { tradeId: trade.id, acceptanceVersion: ACCEPTANCE_VERSION } }]);
  });

  it("tells the opener it waits for the other side to accept", () => {
    const html = render({ role: "buyer", openedBy: "buyer" });
    expect(html).toContain("Waiting for the seller to accept the protected-trade terms.");
    expect(html).not.toContain(ACCEPTANCE_TITLE);
    expect(agreeButton(html)).toBeUndefined();
    expect(html).toContain("Cancel trade");
  });

  it("offers the buyer the USDC trustline the escrow needs, only while it is missing", () => {
    const missing = render({ role: "buyer", openedBy: "seller" }, { trustline: false });
    expect(missing).toContain("The seller proposed a protected trade.");
    expect(missing).toContain("TRUSTLINE USDC before the escrow");
    expect(render({ role: "buyer", openedBy: "seller" }, { trustline: true })).not.toContain("TRUSTLINE");
  });

  it("says cancelling moves no money and deletes the chat", () => {
    expect(render({ role: "buyer", openedBy: "buyer" })).toContain(
      'data-confirm="Its chat will be deleted. Nothing is in escrow, so no money moves."',
    );
  });
});

describe("ProtectedActions once agreed", () => {
  it("tells the buyer to wait for the escrow, with the trustline if it is missing", () => {
    const html = render({ state: "agreed", role: "buyer", openedBy: "buyer" }, { trustline: false });
    expect(html).toContain("Waiting for the seller to create the escrow. Nothing is yours until the release shows here.");
    expect(html).toContain("TRUSTLINE USDC before the escrow");
    expect(html).toContain("Cancel trade");
    expect(html).not.toContain(ACCEPTANCE_TITLE);
  });

  it("gives the seller the escrow creation, then Cancel, and no lock or claim (WP-34)", () => {
    const html = render({ state: "agreed", role: "seller", openedBy: "buyer" });
    expect(html).toMatch(/CREATE PANEL[\s\S]*Cancel trade/);
    expect(html).not.toMatch(/lock|claim/i);
    expect(render({ state: "agreed", role: "buyer", openedBy: "buyer" })).not.toContain("CREATE PANEL");
  });

  it("tells a buyer whose account is not on testnet yet that the escrow can't be created for them (WP-30 N2)", () => {
    for (const state of ["listed", "agreed"]) {
      const html = render({ state, role: "buyer", openedBy: "buyer" }, { account: false });
      expect(html).toContain("Your account isn&#x27;t on Stellar testnet yet, so the seller can&#x27;t create the escrow for you. Fund it first.");
      expect(html).toContain('href="/wallet"');
    }
    expect(render({ state: "agreed", role: "buyer", openedBy: "buyer" })).not.toContain("isn&#x27;t on Stellar testnet yet");
  });
});

describe("ProtectedActions queries", () => {
  it("reads the escrow preflight for the buyer only, and never the claimable lock preflight", () => {
    render({ role: "buyer", openedBy: "buyer" });
    expect(queries).toContainEqual({ path: "escrow.preflight", enabled: true });
    expect(queries.map((q) => q.path)).not.toContain("trade.lockPreflight");

    render({ role: "seller", openedBy: "buyer" });
    expect(queries).toContainEqual({ path: "escrow.preflight", enabled: false });
  });
});

describe("ProtectedActions once the escrow exists (WP-35)", () => {
  const created = { state: "escrow_created", escrowContractId: "CESCROW", viewerUrl: "https://viewer.trustlesswork.com/testnet/v2/CESCROW" };
  const funded = { ...created, state: "funded", disputed: false };
  const disputed = { ...funded, disputed: true };
  const FUNDED = "This escrow is already funded. A dispute is the way to a refund.";

  it("gives the seller the fund, then Cancel, saying the escrow is not funded yet", () => {
    const html = render({ ...created, role: "seller", openedBy: "buyer" });
    expect(html).toMatch(/FUND PANEL[\s\S]*Cancel trade/);
    expect(html).toContain('data-confirm="Its chat will be deleted. The escrow isn&#x27;t funded, so no money moves."');
  });

  it("gives the buyer Cancel while the escrow waits for its fund, and the viewer link (F-16)", () => {
    const html = render({ ...created, role: "buyer", openedBy: "buyer" });
    expect(html).toContain("Cancel trade");
    expect(html).toContain('href="https://viewer.trustlesswork.com/testnet/v2/CESCROW"');
    expect(html).not.toContain("FUND PANEL");
  });

  it("shows the buyer the server's funded sentence when the cancel is refused (F-16, O-27)", () => {
    render({ ...created, role: "buyer", openedBy: "buyer" });
    expect(confirms).toHaveLength(1);
    confirms[0].onConfirm();
    expect(mutated).toEqual([{ path: "trade.cancel", input: { tradeId: trade.id } }]);
    mutationOpts["trade.cancel"].onError!({ message: FUNDED, data: { code: "BAD_REQUEST" } });
    expect(toasts).toEqual([FUNDED]);
  });

  it("gives no one Cancel once funded: the seller releases, the buyer waits", () => {
    const seller = render({ ...funded, role: "seller", openedBy: "buyer" });
    expect(seller).toContain("RELEASE PANEL");
    const buyer = render({ ...funded, role: "buyer", openedBy: "buyer" });
    expect(buyer).not.toContain("RELEASE PANEL");
    for (const html of [seller, buyer]) expect(html).not.toContain("Cancel trade");
  });

  it("tells the waiting buyer what the release pays and that this page shows it, with no claim and no repeat of the status line", () => {
    const html = render({ ...funded, role: "buyer", openedBy: "buyer" }).replaceAll("&#x27;", "'");
    expect(html).toContain("you receive 19.94 USDC");
    expect(html).toContain('href="https://viewer.trustlesswork.com/testnet/v2/CESCROW"');
    expect(html).not.toMatch(/claim/i);
    expect(html).not.toContain("Let go of the cash only when the release shows on this screen.");
  });

  it("leaves a disputed escrow to the dispute panels", () => {
    for (const role of ["seller", "buyer"]) expect(render({ ...disputed, role })).toBe("");
  });
});
