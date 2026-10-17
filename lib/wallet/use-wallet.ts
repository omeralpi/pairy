'use client';

import { createContext, useContext } from "react";

export type WalletKind = "device" | "freighter";

export type Wallet = {
  publicKey: string;
  kind: WalletKind;
  /**
   * Signs a base64 transaction XDR on this device and returns the signed XDR.
   * For the device wallet this prompts for the pincode; for Freighter it opens
   * the extension. Never sends anything to the Pairy server. `summary` is
   * shown in the pincode dialog; aborting `signal` closes that dialog.
   */
  signTransaction: (xdr: string, opts?: { signal?: AbortSignal; summary?: string }) => Promise<string>;
};

/** Everything the onboarding and wallet screens need beyond `useWallet()`. */
export type WalletContextValue = {
  wallet: Wallet | null;
  ready: boolean;
  /** The public key of the encrypted wallet stored in this browser, if any. */
  deviceWalletPublicKey: string | null;
  connectFreighter: () => Promise<Wallet>;
  createDeviceWallet: (pincode: string) => Promise<Wallet>;
  importDeviceWallet: (backup: unknown, pincode: string) => Promise<Wallet>;
  /** Replaces the key stored in this browser with the one in `backup`. */
  replaceDeviceWallet: (backup: unknown, pincode: string) => Promise<Wallet>;
  /** Selects the wallet already stored in this browser. */
  selectDeviceWallet: () => Wallet;
  /**
   * SEP-53 signs `message` with `wallet`; returns a base64 signature. Used for
   * login only. A device wallet prompts for its pincode unless the caller just
   * collected it (create/import), so the user isn't asked twice in a row.
   */
  signMessage: (wallet: Wallet, message: string, pincode?: string) => Promise<string>;
  /** Downloads the pincode-encrypted keystore entry as a JSON file. */
  exportBackup: () => Promise<void>;
  /** Forgets the selected wallet. The device wallet stays stored in this browser. */
  disconnect: () => Promise<void>;
};

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

/** The connected wallet, or null when none is connected/unlocked. */
export function useWallet(): {
  wallet: Wallet | null;
  ready: boolean;
} {
  const { wallet, ready } = useWalletContext();
  return { wallet, ready };
}
