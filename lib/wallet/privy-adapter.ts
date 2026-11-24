'use client';

import { createContext } from "react";

/**
 * What WalletProvider needs from Privy, as a plain object. It is built by
 * components/providers/privy-layer.tsx, the only file that imports Privy, and
 * handed over through PrivyAdapterContext once that chunk has loaded (O-14).
 * Nothing here imports Privy, so the code that paints first stays Privy-free.
 */
export type PrivyAdapter = {
  ready: boolean;
  authenticated: boolean;
  /** "a…@example.com" or "Google"; shown on the wallet page only, never sent to Pairy's server. */
  loginLabel: string | null;
  /** Opens Privy's modal; resolves once authenticated, rejects if the user closes it (PRIVY_LOGIN_CLOSED). */
  login(): Promise<void>;
  logout(): Promise<void>;
  /** The Stellar wallet among the user's linked accounts (oldest if several), or null. */
  stellarAddress(): string | null;
  /** createWallet({ chainType: "stellar" }) → G-address. Never called when stellarAddress() is set. */
  createStellarWallet(): Promise<string>;
  /** Privy signs exactly these 32 bytes and returns the 64 signature bytes. */
  signRawHash(address: string, hash32: Uint8Array): Promise<Uint8Array>;
  /** Opens Privy's own export screen for this wallet. Pairy never sees the key. */
  exportKey(address: string): Promise<void>;
};

/** The user closed Privy's modal: not an error to show, just back to the choices. */
export const PRIVY_LOGIN_CLOSED = "Login cancelled.";

export type PrivyAdapterSlot = {
  /** null until PrivyLayer has loaded, and always null without an App ID. */
  adapter: PrivyAdapter | null;
  setAdapter: (adapter: PrivyAdapter | null) => void;
};

/** Provided by WalletProvider; filled by PrivyLayer. */
export const PrivyAdapterContext = createContext<PrivyAdapterSlot>({ adapter: null, setAdapter: () => {} });
