'use client';

import { createContext, useContext } from "react";

export type WalletKind = "device" | "freighter" | "privy";

export type SignOptions = { signal?: AbortSignal; summary?: string };

/** The slow parts of connecting a Privy wallet: Privy's login modal, createWallet, Friendbot. */
export type PrivyStep = "login" | "creating" | "funding";

export type Wallet = {
  publicKey: string;
  kind: WalletKind;
  /**
   * Signs a base64 transaction XDR and returns the signed XDR. For the device
   * wallet this prompts for the pincode; for Freighter it opens the extension;
   * for Privy it shows Pairy's confirm dialog, then Privy signs the hash.
   * Never sends anything to the Pairy server. `summary` is shown in the
   * dialog; aborting `signal` closes that dialog.
   */
  signTransaction: (xdr: string, opts?: SignOptions) => Promise<string>;
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
  /** Forgets the selected wallet. The device wallet stays stored in this browser; a Privy wallet is logged out of Privy too. */
  disconnect: () => Promise<void>;
  /**
   * Logs in with Privy (email or Google), reuses or creates its Stellar wallet
   * and funds it with Friendbot if needed. `onStep` hears each slow step as it
   * starts, and null once the wallet is connected, so the screen says only what
   * it is waiting for. null when NEXT_PUBLIC_PRIVY_APP_ID is unset (local dev,
   * CI build): the option is hidden.
   */
  connectPrivy: ((onStep?: (step: PrivyStep | null) => void) => Promise<Wallet>) | null;
  /** Opens Privy's own export screen for the selected Privy wallet. Pairy never sees the key. null without an App ID. */
  exportPrivyKey: (() => Promise<void>) | null;
  /** `failed`: Privy's code did not load, or Privy did not answer in time; the Privy option should say so or hide. */
  privy: { enabled: boolean; ready: boolean; failed: boolean; authenticated: boolean; loginLabel: string | null };
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
