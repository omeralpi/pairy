'use client';

import { useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useWalletContext, type Wallet } from "@/lib/wallet/use-wallet";

/**
 * Logs in by signing a one-time challenge with `wallet` on this device. Only
 * the public key, the nonce and the signature are sent to the server.
 */
export function useLogin() {
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const { signMessage } = useWalletContext();
  const challenge = api.auth.challenge.useMutation();
  const verify = api.auth.verify.useMutation();
  const logout = api.auth.logout.useMutation();

  return {
    /** `pincode` only when the user has just entered it for a device wallet. */
    login: async (wallet: Wallet, pincode?: string) => {
      const { nonce, message } = await challenge.mutateAsync({ publicKey: wallet.publicKey });
      const signature = await signMessage(wallet, message, pincode);
      await verify.mutateAsync({ publicKey: wallet.publicKey, nonce, signature });
      await utils.auth.me.invalidate();
    },
    logout: async () => {
      await logout.mutateAsync();
      // Logout is a client-side navigation, so the cache outlives it: drop this
      // account's trades, listings and chat before anyone else signs in here.
      // Active queries (auth.me) refetch as logged out.
      await queryClient.resetQueries();
    },
    pending: challenge.isPending || verify.isPending,
  };
}
