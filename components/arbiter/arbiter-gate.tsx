'use client';

import Link from "next/link";
import { useEffect } from "react";

import { friendlyError, isUnauthorized } from "@/components/friendly-error";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";

const linkClass = "font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

export type ArbiterSigner = { me: string; threshold: number; signers: string[] };

/**
 * The arbiter pages' door (D2 §7.4): only a signed-in key that Horizon lists
 * as a signer of the arbiter account gets through, and nobody while the signer
 * list cannot be confirmed (fail closed). The server enforces the same rule
 * on every arbiter procedure; this only says it in words.
 */
export function ArbiterGate({ children }: { children: (signer: ArbiterSigner) => React.ReactNode }) {
  const utils = api.useUtils();
  const { publicKey, loading } = useSession();
  const me = api.arbiter.me.useQuery(undefined, { enabled: !!publicKey, retry: false, refetchInterval: 60_000 });
  const expired = isUnauthorized(me.error);
  useEffect(() => {
    if (expired) void utils.auth.me.invalidate();
  }, [expired, utils]);

  if (loading) return <Note>Loading…</Note>;
  if (!publicKey || expired) {
    return (
      <Note>
        {expired && "Your session ended. "}
        Sign in with an arbiter signer key.{" "}
        <Link href={`/onboard?next=${encodeURIComponent("/arbiter")}`} className={linkClass}>
          Sign in
        </Link>
      </Note>
    );
  }
  if (me.isLoading) return <Note>Checking the arbiter account&apos;s signers…</Note>;
  if (me.error || !me.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-danger" role="alert">
          {me.error ? friendlyError(me.error) : "Couldn't confirm the signer list. Try again."}
        </p>
        <Button variant="outline" size="sm" onClick={() => me.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!me.data.isSigner) return <Note>This page is only for the arbiter account&apos;s signers.</Note>;
  return <>{children({ me: publicKey, threshold: me.data.threshold, signers: me.data.signers })}</>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate">{children}</p>;
}
