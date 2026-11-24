'use client';

import { ArbiterGate } from "@/components/arbiter/arbiter-gate";
import { ArbiterList } from "@/components/arbiter/arbiter-list";

/** The arbiter's list of open disputes (D2 §7.4). Reached by its address: traders see no link to it. */
export default function ArbiterPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <p className="eyebrow">Arbiter</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
        Open <em className="font-serif font-normal">disputes.</em>
      </h1>
      <div className="mt-12">
        <ArbiterGate>{(signer) => <ArbiterList me={signer.me} threshold={signer.threshold} />}</ArbiterGate>
      </div>
    </div>
  );
}
