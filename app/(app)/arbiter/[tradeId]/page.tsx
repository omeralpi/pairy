'use client';

import Link from "next/link";

import { ArbiterGate } from "@/components/arbiter/arbiter-gate";
import { DisputePanel } from "@/components/arbiter/dispute-panel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One dispute, and the arbiter's signing flow (D2 §7.4). */
export default function ArbiterDisputePage({ params }: { params: { tradeId: string } }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <Link href="/arbiter" className="text-sm text-slate underline decoration-slate/40 underline-offset-4 hover:text-ink">
        ← Open disputes
      </Link>
      <div className="mt-8">
        <ArbiterGate>
          {(signer) =>
            UUID.test(params.tradeId) ? (
              <DisputePanel tradeId={params.tradeId} me={signer.me} />
            ) : (
              <p className="text-sm text-danger">No dispute for the arbiter on this trade.</p>
            )
          }
        </ArbiterGate>
      </div>
    </div>
  );
}
