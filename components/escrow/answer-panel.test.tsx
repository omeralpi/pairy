import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortWhen } from "@/components/trade/format";

// Each trader's one answer to the rule's question once the escrow is disputed
// (D2 §7.3, DECISIONS 10), and what the two answers give. The markup is what
// is on screen; the confirm dialog, the buttons and escrow.answer are stubs
// that record what they were given. `draft` seeds the answer being written
// (the panel's only object state); the clock is fixed per test.
const draft = vi.hoisted(() => ({ value: null as null | { cash: boolean | null; note: string } }));
const sent = vi.hoisted(() => [] as unknown[]);
const answer = vi.hoisted(() => ({ error: null as null | { message: string }, isPending: false }));
const confirms = vi.hoisted(() => [] as { title: string; description: string; confirmLabel: string; onConfirm: () => unknown }[]);
const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => unknown; disabled?: boolean }[]);

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const isDraft = (v: unknown) => typeof v === "object" && v !== null && "cash" in v;
  return { ...react, useState: (v: unknown) => react.useState(isDraft(v) && draft.value ? draft.value : v) };
});
vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useMutation") {
          return () => ({ mutate: (input: unknown) => void sent.push(input), isPending: answer.isPending, error: answer.error });
        }
        if (key === "useUtils") return () => node([]);
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
vi.mock("@/components/ui/button", () => ({
  Button: (p: { children: React.ReactNode; onClick?: () => unknown; disabled?: boolean }) => {
    buttons.push({ label: [p.children].flat().join(""), onClick: p.onClick, disabled: p.disabled });
    return <button disabled={p.disabled}>{p.children}</button>;
  },
}));

const { AnswerPanel } = await import("./answer-panel");

// WP-26's live dispute: the buyer disputed at 13:16:32 (ledger), Pairy recorded it 1.5 s later.
const DISPUTED_AT = new Date("2026-11-24T13:16:32Z");
const RECORDED = new Date("2026-11-24T13:16:33.488Z");
const DEADLINE = new Date(RECORDED.getTime() + 24 * 3600_000);
const PROMISE = new Date(DISPUTED_AT.getTime() + 72 * 3600_000);
const ID = "11111111-1111-4111-8111-111111111111";
const trade = {
  id: ID,
  mode: "protected",
  state: "funded",
  role: "seller",
  seller: "GSELLER",
  buyer: "GBUYER",
  asset: "USDC",
  amount: "2.0000000",
  disputed: true,
  disputedAt: DISPUTED_AT,
  disputeRecordedAt: RECORDED,
  disputeOpenedBy: "buyer",
  answers: { seller: null, buyer: null } as Record<"seller" | "buyer", null | { cashHandedOver: boolean; note: string | null; answeredAt: Date }>,
  answerDeadline: DEADLINE as Date | null,
  promiseDeadline: PROMISE as Date | null,
  // trade.byId's, by the server's clock (O-34).
  answersOpen: true,
};
const said = (cashHandedOver: boolean, note: string | null = null) => ({ cashHandedOver, note, answeredAt: new Date(RECORDED.getTime() + 600_000) });

const QUESTION = "Was the cash handed over in full?";
const CONFIRM = "Are you sure? Your answer cannot be changed.";
const COUNTER = "shown to the other trader and the arbiter; deleted when the trade ends";

const render = (t: Partial<typeof trade> = {}) => {
  buttons.length = 0;
  confirms.length = 0;
  return renderToStaticMarkup(<AnswerPanel trade={{ ...trade, ...t } as never} />)
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');
};
const at = (d: Date | number) => vi.setSystemTime(new Date(d));
const sendButton = () => buttons.find((b) => b.label === "Send my answer");
const form = (html: string) => html.includes('aria-label="Your answer"');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(RECORDED.getTime() + 60_000);
  draft.value = null;
  sent.length = 0;
  answer.error = null;
  answer.isPending = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AnswerPanel: disputed, no answers yet", () => {
  it("asks the rule's one question with Yes and No, a 500-character note and its counter", () => {
    const html = render();
    expect(html).toContain(QUESTION);
    expect(form(html)).toBe(true);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Yes<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>No<\/button>/);
    expect(html).toMatch(/<textarea[^>]*maxLength="500"/);
    expect(html).toContain(COUNTER);
    expect(html).toContain("0/500");
  });

  it("shows the answer deadline, 24 hours from when Pairy recorded the dispute, counting down (DECISIONS 1)", () => {
    const html = render();
    expect(html).toContain(`Answer by ${shortWhen(DEADLINE)}`);
    expect(html).toContain("23:59:00 left");
    at(DEADLINE.getTime() - 5_000);
    expect(render()).toContain("00:00:05 left");
  });

  it("tells each side what happens if no answer arrives, as docs/arbitration.md's rule has it", () => {
    expect(render({ role: "seller" })).toContain("If you send no answer by then and the buyer answers yes, the buyer is paid.");
    expect(render({ role: "buyer" })).toContain("If you send no answer by then, you are paid only if the seller answers yes.");
  });

  it("says the other side has not answered yet, and gives no outcome before the rule can be applied", () => {
    const html = render();
    expect(html).toContain("The buyer hasn't answered yet.");
    expect(html).not.toContain("The rule gives");
  });

  it("holds Send my answer until Yes or No is chosen", () => {
    render();
    expect(sendButton()?.disabled).toBe(true);
    draft.value = { cash: true, note: "" };
    const html = render();
    expect(sendButton()?.disabled).toBe(false);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Yes<\/button>/);
  });
});

describe("AnswerPanel: the confirm step (DECISIONS 10)", () => {
  it("sends nothing from the button itself: only the dialog's confirm does, after Are you sure? Your answer cannot be changed.", () => {
    draft.value = { cash: false, note: "  The buyer never came.  " };
    render();
    expect(sendButton()?.onClick).toBeUndefined();
    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toBe(CONFIRM);
    expect(confirms[0].description).toBe("You answer No: the cash was not handed over in full. Your note goes with it.");
    expect(sent).toEqual([]);
    confirms[0].onConfirm();
    expect(sent).toEqual([{ tradeId: ID, cashHandedOver: false, note: "The buyer never came." }]);
  });

  it("sends Yes with no note when the note is blank", () => {
    draft.value = { cash: true, note: "   " };
    render({ role: "buyer" });
    expect(confirms[0].description).toBe("You answer Yes: the cash was handed over in full.");
    confirms[0].onConfirm();
    expect(sent).toEqual([{ tradeId: ID, cashHandedOver: true, note: undefined }]);
  });

  it("shows the server's refusal, e.g. a second answer from another tab", () => {
    answer.error = { message: "You already answered." };
    expect(render()).toMatch(/role="alert"[^>]*>You already answered\.</);
  });
});

describe("AnswerPanel: one answer given", () => {
  it("replaces my form with my answer and note once I answered, and waits for the other side", () => {
    const html = render({ answers: { seller: said(false, "The buyer never came."), buyer: null } });
    expect(form(html)).toBe(false);
    expect(sendButton()).toBeUndefined();
    expect(html).toContain("You answered No.");
    expect(html).toContain("The buyer never came.");
    expect(html).toContain(`The buyer hasn't answered yet. They have until ${shortWhen(DEADLINE)}.`);
    expect(html).toContain(`The arbiter applies the rule by ${shortWhen(PROMISE)}.`);
    expect(html).not.toContain("The rule gives");
  });

  it("shows me the other side's answer and note while my own form is still open", () => {
    const html = render({ answers: { seller: null, buyer: said(true, "Paid in full at the cafe.") } });
    expect(html).toContain("The buyer answered Yes.");
    expect(html).toContain("Paid in full at the cafe.");
    expect(form(html)).toBe(true);
    expect(html).not.toContain("The rule gives");
  });
});

describe("AnswerPanel: both answers given", () => {
  it("shows both answers and notes, and what the rule gives with its number, before the window ends", () => {
    const html = render({ answers: { seller: said(false, "Never paid."), buyer: said(true, "Paid in full.") } });
    expect(html).toContain("You answered No.");
    expect(html).toContain("Never paid.");
    expect(html).toContain("The buyer answered Yes.");
    expect(html).toContain("Paid in full.");
    expect(html).toContain(`The rule gives: all to the seller (rule 3). The arbiter signs by ${shortWhen(PROMISE)}.`);
    expect(form(html)).toBe(false);
  });

  it("gives the buyer everything when the seller says yes (rule 1)", () => {
    const html = render({ role: "buyer", answers: { seller: said(true), buyer: said(false) } });
    expect(html).toContain("You answered No.");
    expect(html).toContain("The seller answered Yes.");
    expect(html).toContain("The rule gives: all to the buyer (rule 1).");
  });
});

describe("AnswerPanel: the server's clock opens and closes the form (O-34)", () => {
  it("keeps the form while the server says answers are open, though this device's clock runs hours fast", () => {
    at(DEADLINE.getTime() + 2 * 3600_000);
    const html = render({ answersOpen: true });
    expect(form(html)).toBe(true);
    expect(sendButton()).toBeDefined();
    expect(html).toContain("00:00:00 left");
    expect(html).not.toContain("Answers closed");
    expect(html).toContain("The buyer hasn't answered yet.");
    expect(html).not.toContain("The rule gives");
  });

  it("takes the form away once the server says answers are closed, though this device's clock is behind", () => {
    at(RECORDED.getTime() + 60_000);
    const html = render({ answersOpen: false });
    expect(form(html)).toBe(false);
    expect(sendButton()).toBeUndefined();
    expect(html).toContain(`Answers closed at ${shortWhen(DEADLINE)}. You sent no answer.`);
    expect(html).not.toContain(" left");
  });
});

describe("AnswerPanel: the deadline passed", () => {
  it("treats a missing answer as none and applies the rule: all to the seller (rule 3)", () => {
    at(DEADLINE.getTime() + 1000);
    const html = render({ answersOpen: false });
    expect(html).toContain("The buyer sent no answer.");
    expect(html).toContain(`The rule gives: all to the seller (rule 3). The arbiter signs by ${shortWhen(PROMISE)}.`);
  });

  it("pays the buyer when the seller sent no answer and the buyer said yes (rule 2)", () => {
    at(DEADLINE.getTime() + 1000);
    const html = render({ answersOpen: false, answers: { seller: null, buyer: said(true) } });
    expect(html).toContain("The buyer answered Yes.");
    expect(html).toContain("The rule gives: all to the buyer (rule 2).");
  });

  it("closes the form when the server says answers are closed, even if this device's clock is behind", () => {
    answer.error = { message: `Answers closed at ${DEADLINE.toISOString()}.` };
    const html = render();
    expect(form(html)).toBe(false);
    expect(html).toContain(`Answers closed at ${shortWhen(DEADLINE)}. You sent no answer.`);
    expect(html).not.toContain(DEADLINE.toISOString());
  });
});

describe("AnswerPanel once the arbiter settled", () => {
  const settled = (state: string, seller: boolean | null, buyer: boolean | null) =>
    render({
      state,
      answersOpen: false,
      answers: { seller: seller === null ? null : said(seller), buyer: buyer === null ? null : said(buyer) },
      answerDeadline: DEADLINE,
    });

  it("resolved to the buyer: both answers and the rule that gave it (rule 1)", () => {
    at(DEADLINE.getTime() + 3600_000);
    const html = settled("resolved_buyer", true, true);
    expect(html).toContain(QUESTION);
    expect(html).toContain("You answered Yes.");
    expect(html).toContain("The buyer answered Yes.");
    expect(html).toContain("The arbiter applied rule 1: all to the buyer.");
    expect(form(html)).toBe(false);
    expect(html).not.toContain("Answer by");
  });

  it("resolved to the seller: both answers and the rule that gave it (rule 3), seen by the buyer", () => {
    at(DEADLINE.getTime() + 3600_000);
    const html = render({ state: "resolved_seller", role: "buyer", answersOpen: false, answers: { seller: said(false), buyer: said(true) } });
    expect(html).toContain("You answered Yes.");
    expect(html).toContain("The seller answered No.");
    expect(html).toContain("The arbiter applied rule 3: all to the seller.");
  });

  it("says so when a side sent no answer", () => {
    const html = settled("resolved_buyer", null, true);
    expect(html).toContain("You sent no answer.");
    expect(html).toContain("The arbiter applied rule 2: all to the buyer.");
  });

  it("does not claim the rule when the resolution paid the other side than the answers give", () => {
    const html = settled("resolved_buyer", false, true);
    expect(html).toContain("The arbiter paid all to the buyer; the answers give all to the seller (rule 3).");
    expect(html).not.toContain("The arbiter applied rule");
  });
});
