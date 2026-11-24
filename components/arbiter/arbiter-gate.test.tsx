import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Who gets past the arbiter pages' gate (D2 §7.4): only a signed-in key that
// Horizon lists as a signer of the arbiter account, and nobody while the
// signer list cannot be confirmed.
const session = vi.hoisted(() => ({ publicKey: null as string | null, loading: false }));
const me = vi.hoisted(() => ({ result: {} as Record<string, unknown>, enabled: undefined as unknown }));

vi.mock("@/lib/api", () => ({
  api: {
    useUtils: () => ({ auth: { me: { invalidate: () => {} } } }),
    arbiter: {
      me: {
        useQuery: (_input: unknown, opts?: { enabled?: unknown }) => {
          me.enabled = opts?.enabled;
          return me.result;
        },
      },
    },
  },
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => session }));

const { ArbiterGate } = await import("./arbiter-gate");

const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (publicKey: string | null, result: Record<string, unknown>, loading = false) => {
  session.publicKey = publicKey;
  session.loading = loading;
  me.result = { data: undefined, error: null, isLoading: false, refetch: () => {}, ...result };
  return renderToStaticMarkup(<ArbiterGate>{(signer) => <p data-signer={signer.me}>INSIDE {signer.threshold}</p>}</ArbiterGate>);
};

describe("ArbiterGate", () => {
  it("asks for an arbiter signer key when nobody is signed in, linking the onboarding, and does not ask the server", () => {
    const html = render(null, {});
    expect(html).toContain("Sign in with an arbiter signer key.");
    expect(html).toMatch(/<a[^>]*href="\/onboard\?next=%2Farbiter"/);
    expect(html).not.toContain("INSIDE");
    expect(me.enabled).toBe(false);
  });

  it("says it is checking the signer list while arbiter.me loads", () => {
    const html = render(OMER, { isLoading: true });
    expect(text(html)).toContain("Checking the arbiter account's signers…");
    expect(html).not.toContain("INSIDE");
  });

  it("fails closed when Horizon cannot be read, with the server's sentence and a Try again", () => {
    const html = render(OMER, { error: { message: "Couldn't confirm the signer list. Try again.", data: { code: "SERVICE_UNAVAILABLE" } } });
    expect(text(html)).toContain("Couldn't confirm the signer list. Try again.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).not.toContain("INSIDE");
  });

  it("turns a trader away: this page is only for the arbiter account's signers (R2)", () => {
    const html = render("GTRADER", { data: { isSigner: false, threshold: 2, signers: [ENSAR, OMER] } });
    expect(text(html)).toContain("This page is only for the arbiter account's signers.");
    expect(html).not.toContain("INSIDE");
  });

  it("treats a lapsed session as signed out", () => {
    const html = render(OMER, { error: { message: "UNAUTHORIZED", data: { code: "UNAUTHORIZED" } } });
    expect(html).toContain("Sign in with an arbiter signer key.");
    expect(html).not.toContain("INSIDE");
  });

  it("lets a signer through, handing the page who they are and how many signatures a resolution needs", () => {
    const html = render(OMER, { data: { isSigner: true, threshold: 2, signers: [ENSAR, OMER] } });
    expect(html).toMatch(new RegExp(`<p data-signer="${OMER}">INSIDE (<!-- -->)?2</p>`));
    expect(html).not.toContain("only for the arbiter");
  });
});
