// One line, read from the transaction itself, saying what the pincode will
// sign. Used when the caller gives no summary of its own: the claim screens
// describe a claim from the trade record instead, because the claim operation
// carries only a balance id. Freighter shows its own review screen.

import { Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { shortAddress, trimAmount } from "@/components/listing/format";

function hours(seconds: string): string {
  const s = Number(seconds);
  return s % 3600 === 0 ? `${s / 3600} hours` : `${s} seconds`;
}

function describeOperation(op: Transaction["operations"][number]): string {
  switch (op.type) {
    case "createClaimableBalance": {
      const [first] = op.claimants;
      // stellar-sdk 17 decodes predicates as plain { type, relBefore } objects.
      const pred = first?.predicate as unknown as { type?: string; relBefore?: bigint } | undefined;
      const window =
        pred?.type === "claimPredicateBeforeRelativeTime" && pred.relBefore !== undefined
          ? `, claimable by them for ${hours(pred.relBefore.toString())}`
          : "";
      return `Lock ${trimAmount(op.amount)} ${op.asset.getCode()} for ${first ? shortAddress(first.destination) : "nobody"}${window}`;
    }
    case "claimClaimableBalance":
      return `Claim the locked balance ${op.balanceId.slice(0, 12)}…${op.balanceId.slice(-4)}`;
    case "changeTrust":
      return "getCode" in op.line
        ? op.limit === "0.0000000"
          ? `Remove ${op.line.getCode()} from your wallet`
          : `Add ${op.line.getCode()} to your wallet`
        : "Change a trustline";
    case "payment":
      return `Send ${trimAmount(op.amount)} ${op.asset.getCode()} to ${shortAddress(op.destination)}`;
    default:
      return `A ${op.type} operation`;
  }
}

/** "Lock 25 USDC for GABC…WXYZ, claimable by them for 72 hours" on Stellar testnet. */
export function describeTransaction(xdr: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
    const ops = tx.operations.map(describeOperation);
    return ops.length === 1 ? ops[0] : `${ops.length} operations: ${ops.join("; ")}`;
  } catch {
    return "A Stellar testnet transaction";
  }
}
