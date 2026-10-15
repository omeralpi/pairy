'use client';

// STUB — replaced by the wallet agent. The shape below is the contract the
// trade UI relies on; keep it.

export type WalletKind = "device" | "freighter";

export type Wallet = {
  publicKey: string;
  kind: WalletKind;
  /**
   * Signs a base64 transaction XDR on this device and returns the signed XDR.
   * For the device wallet this prompts for the pincode; for Freighter it opens
   * the extension. Never sends anything to the Pairy server.
   */
  signTransaction: (xdr: string) => Promise<string>;
};

/** The connected wallet, or null when none is connected/unlocked. */
export function useWallet(): {
  wallet: Wallet | null;
  ready: boolean;
} {
  return { wallet: null, ready: true };
}
