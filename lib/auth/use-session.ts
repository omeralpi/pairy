'use client';

import { api } from "@/lib/api";

/** The logged-in Stellar public key (from api.auth.me), or null. */
export function useSession(): { publicKey: string | null; loading: boolean } {
  const { data, isLoading } = api.auth.me.useQuery(undefined, { staleTime: 60_000 });
  return { publicKey: data?.publicKey ?? null, loading: isLoading };
}
