'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PincodeDialog } from "@/components/wallet/pincode-dialog";
import { PRIVY_LOGIN_TEXT, SignConfirmDialog } from "@/components/wallet/sign-confirm-dialog";
import { PRIVY_DOWN, PrivyAdapterContext, type PrivyAdapter, type PrivyState } from "@/lib/wallet/privy-adapter";
import {
  WalletContext,
  type PrivyStep,
  type SignOptions,
  type Wallet,
  type WalletContextValue,
  type WalletKind,
} from "@/lib/wallet/use-wallet";

// Both wallet modules are browser-only and the KM bundle is large, so they are
// loaded on first use rather than with the page. The Privy helpers and Horizon
// pull in the Stellar SDK, so they are loaded the same way.
const deviceWallet = () => import("@/lib/wallet/device-wallet");
const freighter = () => import("@/lib/wallet/freighter");
const privySign = () => import("@/lib/wallet/privy-sign");
const horizon = () => import("@/lib/stellar/horizon");
const txSummary = () => import("@/components/wallet/tx-summary");

/** Which wallet this browser last selected. Public data only. */
const SELECTION_KEY = "pairy:wallet";
type Selection = { kind: WalletKind; publicKey: string };

/** The build has a Privy App ID (public; inlined by Next). Without it the Privy option is hidden. */
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/** How long a returning Privy user waits for Privy before the app carries on without it (F-18). */
export const PRIVY_READY_TIMEOUT_MS = 10_000;

export { PRIVY_DOWN };
export const PRIVY_LOADING = "Privy is still loading. Try again in a moment.";
export const PRIVY_OTHER_ACCOUNT = "You signed in to Privy with a different account than this wallet. Use the same email or Google account.";
export const PRIVY_BAD_SIGNATURE = "Privy returned a signature that does not match this transaction. Nothing was sent.";
const PRIVY_TRANSACTION_TEXT =
  "Privy signs only the hash of this testnet transaction; Pairy never sees the key. Nothing is sent until it is signed.";

export type PromptRequest = {
  /** Distinct per request: the confirm dialog is keyed on it, so each request gets a fresh dialog with no earlier error in it. */
  id: number;
  /** Which dialog answers it: the pincode dialog signs on this device; the confirm dialog hands a hash to Privy. */
  kind: "pincode" | "confirm";
  title: string;
  description: string;
  /**
   * What is being signed: the caller's line when it gives one (a claim, whose
   * operation holds only a balance id, is described from the trade record),
   * otherwise decoded from the transaction.
   */
  summary?: string;
  /** Runs with the pincode typed, or with "" from the confirm dialog. */
  run: (input: string) => Promise<void>;
  cancel: () => void;
};

export type PromptOptions = { summary?: string; signal?: AbortSignal };

/**
 * Pairy's confirm dialog as the Privy signing paths see it: it shows `title`,
 * `description` and the summary, and runs `fn` only when the user presses
 * Sign (DECISIONS 12). Taken as a parameter so tests can see what is asked.
 */
export type ConfirmPrompt = <T>(title: string, description: string, fn: () => Promise<T>, opts?: PromptOptions) => Promise<T>;

/**
 * Which saved selection to restore, and whether the provider can say so yet
 * (F-18). Device and Freighter restore as before. A saved Privy selection waits
 * until Privy's chunk has loaded and is ready; then a session authenticated on a
 * different Stellar address clears it, while no session keeps it (signing asks
 * to log in again). If Privy failed or did not answer in time, the selection is
 * kept and the app carries on: the user sees the choices and "Sign in again".
 * Without an App ID it is dropped.
 */
export function restoredSelection(
  saved: Selection | null,
  stored: string | null,
  privy: { enabled: boolean } & PrivyState,
): { selection: Selection | null; ready: boolean } {
  if (saved?.kind === "privy") {
    if (!privy.enabled) return { selection: null, ready: true };
    if (privy.failed) return { selection: saved, ready: true };
    if (!privy.adapter?.ready) return { selection: saved, ready: false };
    const other = privy.adapter.authenticated && privy.adapter.stellarAddress() !== saved.publicKey;
    return { selection: other ? null : saved, ready: true };
  }
  const keep = saved?.kind === "freighter" || (saved?.kind === "device" && saved.publicKey === stored);
  return { selection: keep ? saved : null, ready: true };
}

/** The adapter, once Privy can actually be used: loaded, not failed, and ready (a login before that would hang). */
function livePrivy({ adapter, failed }: PrivyState): PrivyAdapter {
  if (failed) throw new Error(PRIVY_DOWN);
  if (!adapter?.ready) throw new Error(PRIVY_LOADING);
  return adapter;
}

/**
 * A Privy logout the user asked for while Privy could not be reached. Pairy
 * forgot the wallet at once; Privy's own session is ended as soon as Privy is
 * usable again, and before any session is reused (R2-1). Kept in storage like
 * the selection, so it survives the reload that usually follows a logout.
 */
export type OwedLogout = { owed(): boolean; owe(): void; clear(): void };
const OWED_LOGOUT_KEY = "pairy:privy-logout";
const storedOwedLogout: OwedLogout = {
  owed: () => {
    try {
      return localStorage.getItem(OWED_LOGOUT_KEY) !== null;
    } catch {
      return false;
    }
  },
  owe: () => localStorage.setItem(OWED_LOGOUT_KEY, "1"),
  clear: () => localStorage.removeItem(OWED_LOGOUT_KEY),
};

/** Logs out of Privy when it can be asked; otherwise records that the logout is owed. */
export async function logoutPrivy(adapter: PrivyAdapter | null, owed: OwedLogout = storedOwedLogout): Promise<void> {
  if (!adapter?.ready) return owed.owe();
  try {
    await adapter.logout();
  } catch (e) {
    owed.owe();
    throw e;
  }
}

/** Pays an owed logout before Privy's session is used. True when Privy was logged out just now: the session is gone whatever `adapter` still says. */
async function settleOwedLogout(adapter: PrivyAdapter, owed: OwedLogout): Promise<boolean> {
  if (!owed.owed()) return false;
  const hadSession = adapter.authenticated;
  if (hadSession) await adapter.logout();
  owed.clear();
  return hadSession;
}

/**
 * A Privy connect whose login may have left the page: Google's login in
 * Privy's modal is a full-page redirect, so the promise connectPrivyWallet
 * waits on is gone when Google sends the user back to /onboard, logged in to
 * Privy. Marked while that login is open and cleared once it settles here, so
 * a mark found after the page loaded again means Google's redirect. Any wallet
 * chosen, sign-in or logout in this tab ends it too: the user has moved on. In
 * sessionStorage: this tab only, never another tab's login.
 */
export type PendingConnect = { pending(): boolean; mark(): void; clear(): void };
const PENDING_CONNECT_KEY = "pairy:privy-connect";
/** sessionStorage, or nothing where storage is blocked: without the mark, the user clicks once more, as before. */
const tabStorage = () => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};
const storedPendingConnect: PendingConnect = {
  pending: () => tabStorage()?.getItem(PENDING_CONNECT_KEY) != null,
  mark: () => tabStorage()?.setItem(PENDING_CONNECT_KEY, "1"),
  clear: () => tabStorage()?.removeItem(PENDING_CONNECT_KEY),
};

/**
 * Back from Google: true when this tab's Privy connect left the page for its
 * login and Privy is now ready and logged in, so the onboarding carries the
 * connect on without a second click. Decided once, as soon as Privy is ready:
 * the mark is cleared then, so a re-render, a reload or a cancelled Sign in
 * dialog does not start it again. A logout owed (R2-1) wins: that session is
 * about to be ended, and the user is not signed back in.
 */
export function resumesPrivyConnect(
  state: PrivyState,
  pending: PendingConnect = storedPendingConnect,
  owed: OwedLogout = storedOwedLogout,
): boolean {
  if (!state.adapter?.ready || !pending.pending()) return false;
  pending.clear();
  return state.adapter.authenticated && !owed.owed();
}

/** The Privy session a signature needs: logged in, and on this wallet's Stellar address. */
export async function ensurePrivy(state: PrivyState, publicKey: string, owed: OwedLogout = storedOwedLogout): Promise<PrivyAdapter> {
  const adapter = livePrivy(state);
  if ((await settleOwedLogout(adapter, owed)) || !adapter.authenticated) await adapter.login();
  if (adapter.stellarAddress() !== publicKey) throw new Error(PRIVY_OTHER_ACCOUNT);
  return adapter;
}

/**
 * Login, then the Stellar wallet Privy already holds or a new one, then
 * Friendbot if the account is not on testnet yet (DECISIONS 9). Friendbot
 * failing is not fatal: the wallet page has the manual button. `onStep` is
 * told when each of those starts, and null when the wallet is connected.
 * Returns the G-address.
 */
export async function connectPrivyWallet(
  state: PrivyState,
  onStep: (step: PrivyStep | null) => void = () => {},
  owed: OwedLogout = storedOwedLogout,
  pending: PendingConnect = storedPendingConnect,
): Promise<string> {
  const adapter = livePrivy(state);
  if ((await settleOwedLogout(adapter, owed)) || !adapter.authenticated) {
    onStep("login");
    pending.mark();
    try {
      await adapter.login();
    } finally {
      pending.clear();
    }
  }
  // Checked first, so a retry never makes a second wallet.
  let publicKey = adapter.stellarAddress();
  if (!publicKey) {
    onStep("creating");
    publicKey = await adapter.createStellarWallet();
  }
  const { fundWithFriendbot, loadAccount } = await horizon();
  if (!(await loadAccount(publicKey))) {
    onStep("funding");
    await fundWithFriendbot(publicKey).catch((e: unknown) => console.error(e));
  }
  onStep(null);
  return publicKey;
}

/**
 * A Privy signature over a transaction (D1 §5.2): log in again if the session
 * lapsed, then Pairy's dialog, then Privy signs the hash and the SDK verifies
 * the signature before the signed XDR is returned.
 */
export async function privySignTransaction(
  state: PrivyState,
  publicKey: string,
  xdr: string,
  opts: SignOptions | undefined,
  prompt: ConfirmPrompt,
): Promise<string> {
  const privy = await ensurePrivy(state, publicKey);
  const { signXdrWithRawSigner } = await privySign();
  return prompt(
    "Sign transaction",
    PRIVY_TRANSACTION_TEXT,
    () =>
      signXdrWithRawSigner(xdr, publicKey, (hash32) => privy.signRawHash(publicKey, hash32)).catch((e: unknown) => {
        // addSignature checked the signature against the hash and refused it.
        throw e instanceof Error && e.message.includes("Invalid signature") ? new Error(PRIVY_BAD_SIGNATURE) : e;
      }),
    { summary: opts?.summary ?? (await txSummary()).describeTransaction(xdr), signal: opts?.signal },
  );
}

/** The SEP-53 login signature through the same dialog, with DECISIONS 12's line; the challenge text is the summary. */
export async function privySignMessage(state: PrivyState, publicKey: string, message: string, prompt: ConfirmPrompt): Promise<string> {
  const privy = await ensurePrivy(state, publicKey);
  const { signMessageWithRawSigner } = await privySign();
  return prompt("Sign in", PRIVY_LOGIN_TEXT, () => signMessageWithRawSigner(message, (hash32) => privy.signRawHash(publicKey, hash32)), {
    summary: message,
  });
}

/**
 * The machinery behind both dialogs: `setRequest` shows a request, the dialog
 * calls `run` on Sign (with the pincode, or "" from the confirm dialog) and
 * `cancel` on Cancel. One request at a time (`busy`); an aborted signal closes
 * the open one. A plain function so tests can press Sign and Cancel.
 */
export function createPrompt(busy: { current: boolean }, setRequest: (request: PromptRequest | null) => void) {
  let nextId = 0;
  return <T,>(
    kind: PromptRequest["kind"],
    title: string,
    description: string,
    fn: (input: string) => Promise<T>,
    opts: PromptOptions = {},
  ) =>
    new Promise<T>((resolve, reject) => {
      if (busy.current) return reject(new Error("Another signing request is already open."));
      if (opts.signal?.aborted) return reject(new Error("Signing cancelled."));
      busy.current = true;
      // The screen that asked for this signature went away (e.g. the trade
      // was cancelled): close the dialog so a late pincode signs nothing.
      const onAbort = () => {
        done();
        reject(new Error("Signing cancelled."));
      };
      const done = () => {
        busy.current = false;
        opts.signal?.removeEventListener("abort", onAbort);
        setRequest(null);
      };
      opts.signal?.addEventListener("abort", onAbort);
      setRequest({
        id: nextId++,
        kind,
        title,
        description,
        summary: opts.summary,
        run: async (input) => {
          try {
            const result = await fn(input);
            if (opts.signal?.aborted) return;
            done();
            resolve(result);
          } catch (e) {
            // The dialog shows it and the user retries: any Privy error, or a wrong pincode.
            if (kind === "confirm") throw e;
            const { WrongPincodeError } = await deviceWallet();
            if (e instanceof WrongPincodeError) throw e;
            done();
            reject(e);
          }
        },
        cancel: () => {
          done();
          reject(new Error("Signing cancelled."));
        },
      });
    });
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [deviceWalletPublicKey, setDeviceWalletPublicKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const busy = useRef(false);
  // Filled by PrivyLayer once its chunk has loaded (O-14), or marked failed by
  // its error boundary or the F-18 timeout. The signing closures read it
  // through the ref, so a wallet object does not change with Privy's state.
  const [adapter, setAdapter] = useState<PrivyAdapter | null>(null);
  const [privyBroken, setPrivyBroken] = useState(false);
  const setFailed = useCallback(() => setPrivyBroken(true), []);
  // A timed-out Privy that turns up later is used after all.
  const privyFailed = privyBroken && !adapter?.ready;
  const privyRef = useRef<PrivyState>({ adapter, failed: privyFailed });
  privyRef.current = { adapter, failed: privyFailed };
  const privySlot = useMemo(() => ({ adapter, setAdapter, setFailed }), [adapter, setFailed]);

  useEffect(() => {
    (async () => {
      let restored: ReturnType<typeof restoredSelection> = { selection: null, ready: true };
      try {
        const stored = await (await deviceWallet()).getDeviceWalletPublicKey();
        setDeviceWalletPublicKey(stored);
        const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
        restored = restoredSelection(saved, stored, { enabled: PRIVY_ENABLED, ...privyRef.current });
        setSelection(restored.selection);
      } catch (e) {
        // Storage blocked or a corrupt selection: start with no wallet selected.
        console.error(e);
      } finally {
        setReady(restored.ready);
      }
    })();
  }, []);

  // A saved Privy selection is decided once Privy is ready, or has failed (F-18).
  useEffect(() => {
    if (ready || selection?.kind !== "privy" || (!adapter?.ready && !privyFailed)) return;
    const restored = restoredSelection(selection, deviceWalletPublicKey, { enabled: PRIVY_ENABLED, adapter, failed: privyFailed });
    setSelection(restored.selection);
    setReady(restored.ready);
  }, [ready, selection, adapter, privyFailed, deviceWalletPublicKey]);

  // The wait is bounded: a Privy that never answers must not hold the returning
  // user on the loading screen, nor leave the newcomer's choice on "Opening
  // Privy…" (D1 §7.1). A Privy that turns up ready later is used after all.
  useEffect(() => {
    if (!PRIVY_ENABLED || adapter?.ready) return;
    const timer = setTimeout(() => setPrivyBroken(true), PRIVY_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [adapter]);

  // A logout owed from a logout made while Privy was down is paid as soon as
  // Privy can be asked, before anyone clicks (R2-1).
  useEffect(() => {
    if (adapter?.ready) settleOwedLogout(adapter, storedOwedLogout).catch((e: unknown) => console.error(e));
  }, [adapter]);

  const select = useCallback((next: Selection | null) => {
    if (next) localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SELECTION_KEY);
    // A wallet chosen, or none, ends a Privy connect left pending by Google's redirect.
    storedPendingConnect.clear();
    setSelection(next);
  }, []);

  const withPrompt = useMemo(() => createPrompt(busy, setRequest), []);
  const confirm = useCallback<ConfirmPrompt>((title, description, fn, opts) => withPrompt("confirm", title, description, fn, opts), [withPrompt]);

  const toWallet = useCallback(
    ({ kind, publicKey }: Selection): Wallet => ({
      kind,
      publicKey,
      signTransaction:
        kind === "device"
          ? async (xdr, opts) =>
              withPrompt(
                "pincode",
                "Sign transaction",
                "Enter your pincode to sign this testnet transaction on this device.",
                async (pin) => (await deviceWallet()).signTransactionWithDeviceWallet(publicKey, xdr, pin),
                {
                  summary: opts?.summary ?? (await txSummary()).describeTransaction(xdr),
                  signal: opts?.signal,
                },
              )
          : kind === "privy"
            ? (xdr, opts) => privySignTransaction(privyRef.current, publicKey, xdr, opts, confirm)
            : async (xdr) => (await freighter()).signTransactionWithFreighter(publicKey, xdr),
    }),
    [withPrompt, confirm],
  );

  const value = useMemo<WalletContextValue>(() => {
    const choose = (next: Selection) => {
      select(next);
      return toWallet(next);
    };
    return {
      wallet: selection ? toWallet(selection) : null,
      ready,
      deviceWalletPublicKey,

      connectFreighter: async () => choose({ kind: "freighter", publicKey: await (await freighter()).connectFreighter() }),

      connectPrivy: PRIVY_ENABLED
        ? async (onStep) => choose({ kind: "privy", publicKey: await connectPrivyWallet(privyRef.current, onStep) })
        : null,

      resumePrivy: PRIVY_ENABLED ? () => resumesPrivyConnect(privyRef.current) : null,

      createDeviceWallet: async (pincode) => {
        const publicKey = await (await deviceWallet()).createDeviceWallet(pincode);
        setDeviceWalletPublicKey(publicKey);
        return choose({ kind: "device", publicKey });
      },

      importDeviceWallet: async (backup, pincode) => {
        const publicKey = await (await deviceWallet()).importDeviceWallet(backup, pincode);
        setDeviceWalletPublicKey(publicKey);
        return choose({ kind: "device", publicKey });
      },

      replaceDeviceWallet: async (backup, pincode) => {
        // The key this page showed as the one being removed.
        const shown = deviceWalletPublicKey ?? undefined;
        const publicKey = await (await deviceWallet()).replaceDeviceWallet(backup, pincode, localStorage, shown);
        setDeviceWalletPublicKey(publicKey);
        return choose({ kind: "device", publicKey });
      },

      selectDeviceWallet: () => {
        if (!deviceWalletPublicKey) throw new Error("No wallet is stored in this browser.");
        return choose({ kind: "device", publicKey: deviceWalletPublicKey });
      },

      signMessage: async (wallet, message, pincode) => {
        // Signing in with a wallet, as "Sign in again" does without choosing one, ends it too.
        storedPendingConnect.clear();
        if (wallet.kind === "device" && pincode !== undefined) {
          return (await deviceWallet()).signMessageWithDeviceWallet(wallet.publicKey, message, pincode);
        }
        if (wallet.kind === "privy") return privySignMessage(privyRef.current, wallet.publicKey, message, confirm);
        return wallet.kind === "device"
          ? withPrompt("pincode", "Sign in", "Enter your pincode to sign the Pairy login message. Nothing is sent but the signature.", async (pin) =>
              (await deviceWallet()).signMessageWithDeviceWallet(wallet.publicKey, message, pin),
            )
          : (await freighter()).signMessageWithFreighter(wallet.publicKey, message);
      },

      exportBackup: async () => {
        if (!deviceWalletPublicKey) throw new Error("No wallet is stored in this browser.");
        const entry = await (await deviceWallet()).exportDeviceWallet(deviceWalletPublicKey);
        const url = URL.createObjectURL(new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `pairy-testnet-wallet-${deviceWalletPublicKey.slice(0, 8)}.json`;
        // Attached and revoked a tick later: iOS Safari and older Firefox drop
        // the download when the link is detached or the URL is already gone.
        document.body.append(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          a.remove();
        }, 0);
      },

      exportPrivyKey: PRIVY_ENABLED
        ? async () => {
            if (selection?.kind !== "privy") throw new Error("No Privy wallet is selected.");
            const privy = await ensurePrivy(privyRef.current, selection.publicKey);
            await privy.exportKey(selection.publicKey);
          }
        : null,

      privy: {
        enabled: PRIVY_ENABLED,
        ready: adapter?.ready ?? false,
        failed: privyFailed,
        authenticated: adapter?.authenticated ?? false,
        loginLabel: adapter?.loginLabel ?? null,
      },

      disconnect: async () => {
        // Before Varial's disconnect, which can throw before select(null) is reached.
        storedPendingConnect.clear();
        if (selection?.kind === "freighter") await (await freighter()).disconnectFreighter();
        const wasPrivy = selection?.kind === "privy";
        // The wallet is forgotten first: a Privy that is down or still loading
        // cannot answer a logout, and must not keep the wallet selected. Its
        // session is then ended as soon as it can be asked.
        select(null);
        if (wasPrivy) await logoutPrivy(privyRef.current.adapter);
      },
    };
  }, [selection, ready, deviceWalletPublicKey, adapter, privyFailed, select, toWallet, withPrompt, confirm]);

  return (
    <PrivyAdapterContext.Provider value={privySlot}>
      <WalletContext.Provider value={value}>
        {children}
        <PincodeDialog
          open={request?.kind === "pincode"}
          title={request?.title ?? ""}
          description={request?.description ?? ""}
          summary={request?.summary}
          onSubmit={(pin) => request!.run(pin)}
          onCancel={() => request?.cancel()}
        />
        <SignConfirmDialog
          key={request?.id}
          open={request?.kind === "confirm"}
          title={request?.title ?? ""}
          description={request?.description ?? ""}
          summary={request?.summary}
          onConfirm={() => request!.run("")}
          onCancel={() => request?.cancel()}
        />
      </WalletContext.Provider>
    </PrivyAdapterContext.Provider>
  );
}
