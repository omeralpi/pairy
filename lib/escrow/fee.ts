// Trustless Work's fee on every way out of an escrow, release or resolution:
// 0.3% of what the escrow holds, rounded down to the stroop, sent to
// TW_FEE_ADDRESS. Pairy's own platform fee is 0. Checked against the exits
// recorded on testnet (fee.test.ts): 10 USDC paid 0.03, 12.3456789 paid 0.037037.

/** Trustless Work's fee on an escrow holding `amountStroops`, in stroops. */
export function twFee(amountStroops: bigint): bigint {
  return (amountStroops * 3n) / 1000n;
}

/** What the payee receives from an escrow holding `amountStroops`, in stroops. */
export function netAfterFee(amountStroops: bigint): bigint {
  return amountStroops - twFee(amountStroops);
}
