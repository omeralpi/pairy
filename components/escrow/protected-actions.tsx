'use client';

import { useState } from "react";

import { ConfirmAction } from "@/components/confirm-action";
import { AcceptanceScreen } from "@/components/escrow/acceptance-screen";
import { roleName, type TradeView } from "@/components/trade/format";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { useMutationOpts } from "@/components/trade/use-mutation-opts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";

/**
 * What the viewer can do now in a protected trade, by role and state: the
 * peer who did not open it accepts the protected-trade terms by agreeing, and
 * the buyer adds the USDC trustline the escrow needs. The escrow's own panels
 * (create, fund, release, dispute) come in later work packages.
 */
export function ProtectedActions({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const opts = useMutationOpts();
  const agree = api.trade.agree.useMutation(opts);
  const cancel = api.trade.cancel.useMutation(opts);
  const [accepted, setAccepted] = useState(false);
  // Trustless Work refuses to create an escrow whose receiver has no USDC trustline.
  const preflight = api.escrow.preflight.useQuery(
    { tradeId: trade.id },
    { enabled: trade.role === "buyer" && (trade.state === "listed" || trade.state === "agreed"), refetchInterval: 30_000 },
  );
  const buyerNeedsTrustline = preflight.data?.checks.some((c) => c.id === "buyerTrustline" && !c.ok);
  const other = roleName(trade.role === "seller" ? "buyer" : "seller").toLowerCase();

  const cancelButton = (
    <ConfirmAction
      title="Cancel this trade?"
      description="Its chat will be deleted. Nothing is in escrow, so no money moves."
      confirmLabel="Cancel trade"
      onConfirm={() => cancel.mutate({ tradeId: trade.id })}
    >
      <Button variant="ghost" size="sm" className="-ml-4 text-slate hover:text-ink" disabled={cancel.isPending}>
        Cancel trade
      </Button>
    </ConfirmAction>
  );

  const trustline = buyerNeedsTrustline && (
    <TrustlineButton asset="USDC" buyer={trade.buyer} escrow onDone={() => utils.trade.invalidate()} />
  );

  switch (trade.state) {
    case "listed":
      return (
        <section className="space-y-5">
          {trade.role === trade.openedBy ? (
            <p className="leading-relaxed text-slate">Waiting for the {other} to accept the protected-trade terms.</p>
          ) : (
            <>
              <p className="leading-relaxed text-slate">The {other} proposed a protected trade.</p>
              <AcceptanceScreen accepted={accepted} onAcceptedChange={setAccepted} />
              <Button
                variant="beacon"
                disabled={!accepted || agree.isPending}
                onClick={() => agree.mutate({ tradeId: trade.id, acceptanceVersion: ACCEPTANCE_VERSION })}
              >
                Agree and accept
              </Button>
            </>
          )}
          {trustline}
          <div>{cancelButton}</div>
        </section>
      );
    case "agreed":
      return trade.role === "seller" ? (
        <div className="space-y-6">{cancelButton}</div>
      ) : (
        <section className="space-y-5">
          <p className="leading-relaxed text-slate">
            Waiting for the seller to create the escrow. Nothing is yours until the release shows here.
          </p>
          {trustline}
          <div>{cancelButton}</div>
        </section>
      );
    default:
      return null;
  }
}
