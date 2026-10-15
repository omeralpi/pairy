'use client';

// STUB — replaced by the wallet agent. Shape is the contract other UI uses.

/** The logged-in Stellar public key (from api.auth.me), or null. */
export function useSession(): { publicKey: string | null; loading: boolean } {
  return { publicKey: null, loading: false };
}
