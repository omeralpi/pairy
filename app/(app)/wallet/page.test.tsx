import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The wallet page as it renders for one connected wallet, with Horizon's
// account read already done. No browser: the markup is enough to see what the
// page says about recovery, export and logging out.
const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown>, session: null as string | null }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: null, error: null, isLoading: false, refetch: async () => {} }),
}));
vi.mock("@/lib/auth/use-login", () => ({ useLogin: () => ({ login: async () => {}, logout: async () => {}, pending: false }) }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: ctx.session, loading: false }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWalletContext: () => ctx.value }));

const { default: WalletPage } = await import("./page");

const publicKey = "GPRIVY00000000000000000000000000000000000000000000000000";
const wallet = (kind: string) => ({ kind, publicKey, signTransaction: async () => "" });
const base = {
  ready: true,
  deviceWalletPublicKey: null,
  exportBackup: async () => {},
  disconnect: async () => {},
  exportPrivyKey: async () => {},
  privy: { enabled: true, ready: true, failed: false, authenticated: true, loginLabel: "a…@example.com" },
};
const render = (value: Record<string, unknown>, session: string | null = publicKey) => {
  ctx.value = value;
  ctx.session = session;
  return renderToStaticMarkup(<WalletPage />);
};

describe("WalletPage for a Privy wallet", () => {
  it("names the kind Email wallet (Privy) in the eyebrow", () => {
    const html = render({ ...base, wallet: wallet("privy") });
    expect(html).toContain("Wallet · Email wallet (Privy) · testnet");
    expect(html).not.toContain("Key on this device");
  });

  it("explains that recovery is the login and who controls the wallet, and shows the login locally", () => {
    const html = render({ ...base, wallet: wallet("privy") });
    expect(html).toContain("Recovery is your login.");
    expect(html).toContain(
      "Sign in with the same email or Google account in any browser to open this wallet. Pairy keeps no copy; Privy holds it in two pieces. Whoever controls that email or Google account controls this wallet.",
    );
    expect(html).toContain("a…@example.com");
    // Privy's SDK copies its login token into a cookie the browser sends to Pairy's server, so the
    // panel may promise only what Pairy's code does with it: nothing (O-43, as README says).
    expect(html).toContain("Pairy never reads or stores this login; it knows this wallet only by its Stellar address.");
    expect(html).not.toMatch(/server never receives this|only the Stellar address is sent/);
  });

  it("offers Export key through Privy's own screen, with the Varial note, and no device backup", () => {
    const html = render({ ...base, wallet: wallet("privy") });
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Export key<\/button>/);
    expect(html).toContain("Pairy never sees the key");
    expect(html).toMatch(
      /<a[^>]*href="https:\/\/github\.com\/omeralpi\/pairy\/blob\/main\/README\.md#use-this-key-in-varial"[^>]*>Using it in Varial \(formerly Freighter\)/,
    );
    expect(html).not.toContain("Export backup");
  });

  it("links to a README note that exists and tells the user where the exported key may go", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    // The note alone: from its heading to the next heading or rule.
    const note = readme.split(/^### Use this key in Varial$/m)[1]?.split(/^(?:---|#{1,3} )/m)[0];
    expect(note, "README.md has no '### Use this key in Varial' heading").toBeDefined();
    // The key's one destination, named as the extension ships today (O-30), and that Pairy is not one of them.
    expect(note).toContain("Varial (formerly Freighter)");
    expect(note).toContain("Import a Stellar secret key");
    expect(note).toMatch(/never paste it anywhere else/i);
    // The offline converter reads the key from stdin, never from the command line (shell history).
    const converter = note!.match(/```sh\n(node -e '[^\n]*')\n```/)?.[1];
    expect(converter, "the note has no node -e converter in a ```sh block").toBeDefined();
    expect(converter).toContain("process.stdin");
    expect(converter).not.toContain("process.argv");
    // The package that receives the key is pinned to the verified version, and copying the
    // commands replaced the key in the clipboard, so the note asks for a fresh copy.
    expect(note).toContain("npm i @stellar/stellar-base@15.0.0");
    expect(note).toContain("press **Copy key** in Privy again");
  });

  it("names the extension Varial (formerly Freighter) at README's first mention of either name (O-30)", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const first = readme.search(/Varial|Freighter/);
    expect(readme.slice(first, first + "Varial (formerly Freighter)".length)).toBe("Varial (formerly Freighter)");
  });

  it("says that logging out also signs out of Privy", () => {
    const html = render({ ...base, wallet: wallet("privy") });
    expect(html).toContain("Logging out also signs you out of Privy.");
    expect(html).not.toContain("keeps the locked key in this browser");
  });

  it("leaves the login label out when Privy has none", () => {
    const html = render({ ...base, wallet: wallet("privy"), privy: { ...base.privy, loginLabel: null } });
    expect(html).toContain("Recovery is your login.");
    expect(html).not.toContain("Signed in with");
  });
});

describe("WalletPage for the other kinds", () => {
  it("keeps the device wallet's backup panel and logout note, with no Privy panel", () => {
    const html = render({ ...base, wallet: wallet("device"), deviceWalletPublicKey: publicKey });
    expect(html).toContain("Wallet · Key on this device · testnet");
    expect(html).toContain("Export backup");
    expect(html).toContain("keeps the locked key in this browser");
    expect(html).not.toContain("Privy");
  });

  it("names the email option among the ways in when no wallet is connected, only with an App ID (N2)", () => {
    expect(render({ ...base, wallet: null }, null)).toContain("Sign in with email or Google, make a key on this device, use Varial (formerly Freighter), or restore a backup file.");
    expect(render({ ...base, wallet: null, privy: { ...base.privy, enabled: false } }, null)).toContain(
      "Make a key on this device, use Varial (formerly Freighter), or restore a backup file.",
    );
  });

  it("shows Varial (formerly Freighter) with neither panel", () => {
    const html = render({ ...base, wallet: wallet("freighter") });
    expect(html).toContain("Wallet · Varial (formerly Freighter) · testnet");
    expect(html).not.toContain("Export backup");
    expect(html).not.toContain("Privy");
  });
});
