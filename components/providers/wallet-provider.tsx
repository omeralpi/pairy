'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PincodeDialog } from "@/components/wallet/pincode-dialog";
import { PRIVY_LOGIN_TEXT, SignConfirmDialog } from "@/components/wallet/sign-confirm-dialog";
import { PrivyAdapterContext, type PrivyAdapter } from "@/lib/wallet/privy-adapter";
import { WalletContext, type Wallet, type WalletContextValue, type WalletKind } from "@/lib/wallet/use-wallet";

// Both wallet modules are browser-only and the KM bundle is large, so they are
// loaded on first use rather than with the page. The Privy helpers and Horizon
// pull in the Stellar SDK, so they are loaded the same way.
const deviceWallet = () => import("@/lib/wallet/device-wallet");
const freighter = () => import("@/lib/wallet/freighter");
const privySign = () => import("@/lib/wallet/privy-sign");
const horizon = () => import("@/lib/stellar/horizon");

/** Which wallet this browser last selected. Public data only. */
const SELECTION_KEY = "pairy:wallet";
type Selection = { kind: WalletKind; publicKey: string };

/** The build has a Privy App ID (public; inlined by Next). Without it the Privy option is hidden. */
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const PRIVY_LOADING = "Privy is still loading. Try again in a moment.";
const PRIVY_OTHER_ACCOUNT = "You signed in to Privy with a different account than this wallet. Use the same email or Google account.";
const PRIVY_BAD_SIGNATURE = "Privy returned a signature that does not match this transaction. Nothing was sent.";

type PromptRequest = {
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

/**
 * Which saved selection to restore, and whether the provider can say so yet
 * (F-18). Device and Freighter restore as before. A saved Privy selection waits
 * until Privy's chunk has loaded and is ready; then a session authenticated on a
 * different Stellar address clears it, while no session keeps it (signing asks
 * to log in again). Without an App ID it is dropped.
 */
export function restoredSelection(
  saved: Selection | null,
  stored: string | null,
  privy: { enabled: boolean; adapter: PrivyAdapter | null },
): { selection: Selection | null; ready: boolean } {
  if (saved?.kind === "privy") {
    if (!privy.enabled) return { selection: null, ready: true };
    if (!privy.adapter?.ready) return { selection: saved, ready: false };
    const other = privy.adapter.authenticated && privy.adapter.stellarAddress() !== saved.publicKey;
    return { selection: other ? null : saved, ready: true };
  }
  const keep = saved?.kind === "freighter" || (saved?.kind === "device" && saved.publicKey === stored);
  return { selection: keep ? saved : null, ready: true };
}

/** The Privy session a signature needs: logged in, and on this wallet's Stellar address. */
export async function ensurePrivy(adapter: PrivyAdapter | null, publicKey: string): Promise<PrivyAdapter> {
  if (!adapter) throw new Error(PRIVY_LOADING);
  if (!adapter.authenticated) await adapter.login();
  if (adapter.stellarAddress() !== publicKey) throw new Error(PRIVY_OTHER_ACCOUNT);
  return adapter;
}

/**
 * Login, then the Stellar wallet Privy already holds or a new one, then
 * Friendbot if the account is not on testnet yet (DECISIONS 9). Friendbot
 * failing is not fatal: the wallet page has the manual button. Returns the
 * G-address.
 */
export async function connectPrivyWallet(adapter: PrivyAdapter | null): Promise<string> {
  if (!adapter) throw new Error(PRIVY_LOADING);
  if (!adapter.authenticated) await adapter.login();
  // Checked first, so a retry never makes a second wallet.
  const publicKey = adapter.stellarAddress() ?? (await adapter.createStellarWallet());
  const { fundWithFriendbot, loadAccount } = await horizon();
  if (!(await loadAccount(publicKey))) await fundWithFriendbot(publicKey).catch((e: unknown) => console.error(e));
  return publicKey;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [deviceWalletPublicKey, setDeviceWalletPublicKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const busy = useRef(false);
  // Filled by PrivyLayer once its chunk has loaded (O-14). The signing closures
  // read it through the ref, so a wallet object does not change with Privy's state.
  const [adapter, setAdapter] = useState<PrivyAdapter | null>(null);
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const privySlot = useMemo(() => ({ adapter, setAdapter }), [adapter]);

  useEffect(() => {
    (async () => {
      let restored: ReturnType<typeof restoredSelection> = { selection: null, ready: true };
      try {
        const stored = await (await deviceWallet()).getDeviceWalletPublicKey();
        setDeviceWalletPublicKey(stored);
        const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
        restored = restoredSelection(saved, stored, { enabled: PRIVY_ENABLED, adapter: adapterRef.current });
        setSelection(restored.selection);
      } catch (e) {
        // Storage blocked or a corrupt selection: start with no wallet selected.
        console.error(e);
      } finally {
        setReady(restored.ready);
      }
    })();
  }, []);

  // A saved Privy selection is decided once Privy is ready (F-18).
  useEffect(() => {
    if (ready || selection?.kind !== "privy" || !adapter?.ready) return;
    const restored = restoredSelection(selection, deviceWalletPublicKey, { enabled: PRIVY_ENABLED, adapter });
    setSelection(restored.selection);
    setReady(restored.ready);
  }, [ready, selection, adapter, deviceWalletPublicKey]);

  const select = useCallback((next: Selection | null) => {
    if (next) localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SELECTION_KEY);
    setSelection(next);
  }, []);

  /** Opens the pincode or confirm dialog and resolves with whatever `fn` returns once it succeeds. */
  const withPrompt = useCallback(
    <T,>(
      kind: PromptRequest["kind"],
      title: string,
      description: string,
      fn: (input: string) => Promise<T>,
      opts: { summary?: string; signal?: AbortSignal } = {},
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
      }),
    [],
  );

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
                  summary: opts?.summary ?? (await import("@/components/wallet/tx-summary")).describeTransaction(xdr),
                  signal: opts?.signal,
                },
              )
          : kind === "privy"
            ? async (xdr, opts) => {
                // Log in again if the Privy session lapsed, then Pairy's dialog, then Privy signs the hash (D1 §5.2).
                const privy = await ensurePrivy(adapterRef.current, publicKey);
                const { signXdrWithRawSigner } = await privySign();
                return withPrompt(
                  "confirm",
                  "Sign transaction",
                  "Privy signs the hash of this testnet transaction. Nothing is sent until it is signed.",
                  () =>
                    signXdrWithRawSigner(xdr, publicKey, (hash32) => privy.signRawHash(publicKey, hash32)).catch((e: unknown) => {
                      // addSignature checked the signature against the hash and refused it.
                      throw e instanceof Error && e.message.includes("Invalid signature") ? new Error(PRIVY_BAD_SIGNATURE) : e;
                    }),
                  {
                    summary: opts?.summary ?? (await import("@/components/wallet/tx-summary")).describeTransaction(xdr),
                    signal: opts?.signal,
                  },
                );
              }
            : async (xdr) => (await freighter()).signTransactionWithFreighter(publicKey, xdr),
    }),
    [withPrompt],
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

      connectPrivy: PRIVY_ENABLED ? async () => choose({ kind: "privy", publicKey: await connectPrivyWallet(adapterRef.current) }) : null,

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
        if (wallet.kind === "device" && pincode !== undefined) {
          return (await deviceWallet()).signMessageWithDeviceWallet(wallet.publicKey, message, pincode);
        }
        if (wallet.kind === "privy") {
          // Pairy's dialog before the login signature too (DECISIONS 12); the challenge text is the summary.
          const privy = await ensurePrivy(adapterRef.current, wallet.publicKey);
          const { signMessageWithRawSigner } = await privySign();
          return withPrompt(
            "confirm",
            "Sign in",
            PRIVY_LOGIN_TEXT,
            () => signMessageWithRawSigner(message, (hash32) => privy.signRawHash(wallet.publicKey, hash32)),
            { summary: message },
          );
        }
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
            const privy = await ensurePrivy(adapterRef.current, selection.publicKey);
            await privy.exportKey(selection.publicKey);
          }
        : null,

      privy: {
        enabled: PRIVY_ENABLED,
        ready: adapter?.ready ?? false,
        authenticated: adapter?.authenticated ?? false,
        loginLabel: adapter?.loginLabel ?? null,
      },

      disconnect: async () => {
        if (selection?.kind === "freighter") await (await freighter()).disconnectFreighter();
        if (selection?.kind === "privy") await adapterRef.current?.logout();
        select(null);
      },
    };
  }, [selection, ready, deviceWalletPublicKey, adapter, select, toWallet, withPrompt]);

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
