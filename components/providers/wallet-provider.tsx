'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PincodeDialog } from "@/components/wallet/pincode-dialog";
import { WalletContext, type Wallet, type WalletContextValue, type WalletKind } from "@/lib/wallet/use-wallet";

// Both wallet modules are browser-only and the KM bundle is large, so they are
// loaded on first use rather than with the page.
const deviceWallet = () => import("@/lib/wallet/device-wallet");
const freighter = () => import("@/lib/wallet/freighter");

/** Which wallet this browser last selected. Public data only. */
const SELECTION_KEY = "pairy:wallet";
type Selection = { kind: WalletKind; publicKey: string };

type PincodeRequest = {
  title: string;
  description: string;
  /**
   * What is being signed: the caller's line when it gives one (a claim, whose
   * operation holds only a balance id, is described from the trade record),
   * otherwise decoded from the transaction.
   */
  summary?: string;
  run: (pincode: string) => Promise<void>;
  cancel: () => void;
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [deviceWalletPublicKey, setDeviceWalletPublicKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [request, setRequest] = useState<PincodeRequest | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await (await deviceWallet()).getDeviceWalletPublicKey();
        setDeviceWalletPublicKey(stored);
        const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
        if (saved?.kind === "freighter" || (saved?.kind === "device" && saved.publicKey === stored)) {
          setSelection(saved);
        }
      } catch (e) {
        // Storage blocked or a corrupt selection: start with no wallet selected.
        console.error(e);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const select = useCallback((next: Selection | null) => {
    if (next) localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SELECTION_KEY);
    setSelection(next);
  }, []);

  /** Opens the pincode dialog and resolves with whatever `fn` returns once a pincode works. */
  const withPincode = useCallback(
    <T,>(
      title: string,
      description: string,
      fn: (pincode: string) => Promise<T>,
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
          title,
          description,
          summary: opts.summary,
          run: async (pincode) => {
            const { WrongPincodeError } = await deviceWallet();
            try {
              const result = await fn(pincode);
              if (opts.signal?.aborted) return;
              done();
              resolve(result);
            } catch (e) {
              if (e instanceof WrongPincodeError) throw e; // dialog shows it; user retries
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
              withPincode(
                "Sign transaction",
                "Enter your pincode to sign this testnet transaction on this device.",
                async (pin) => (await deviceWallet()).signTransactionWithDeviceWallet(publicKey, xdr, pin),
                {
                  summary: opts?.summary ?? (await import("@/components/wallet/tx-summary")).describeTransaction(xdr),
                  signal: opts?.signal,
                },
              )
          : async (xdr) => (await freighter()).signTransactionWithFreighter(publicKey, xdr),
    }),
    [withPincode],
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
        return wallet.kind === "device"
          ? withPincode("Sign in", "Enter your pincode to sign the Pairy login message. Nothing is sent but the signature.", async (pin) =>
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

      disconnect: async () => {
        if (selection?.kind === "freighter") await (await freighter()).disconnectFreighter();
        select(null);
      },
    };
  }, [selection, ready, deviceWalletPublicKey, select, toWallet, withPincode]);

  return (
    <WalletContext.Provider value={value}>
      {children}
      <PincodeDialog
        open={request !== null}
        title={request?.title ?? ""}
        description={request?.description ?? ""}
        summary={request?.summary}
        onSubmit={(pin) => request!.run(pin)}
        onCancel={() => request?.cancel()}
      />
    </WalletContext.Provider>
  );
}
