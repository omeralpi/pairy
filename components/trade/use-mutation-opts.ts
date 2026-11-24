'use client';

import { toast } from "sonner";

import { friendlyError, isUnauthorized } from "@/components/friendly-error";
import { api } from "@/lib/api";

/** What every trade-room button does after its mutation: refresh the trade, or say what went wrong. */
export function useMutationOpts() {
  const utils = api.useUtils();
  return {
    onSuccess: () => utils.trade.invalidate(),
    onError: (e: { message: string; data?: { code?: string } | null }) => {
      toast.error(friendlyError(e));
      // A lapsed session: let the page fall back to its sign-in prompt.
      if (isUnauthorized(e)) void utils.auth.me.invalidate();
      // The trade may have moved on in another tab; show where it stands now.
      else void utils.trade.invalidate();
    },
  };
}
