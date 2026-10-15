// What must be true on-chain before the seller locks, read from Horizon so the
// lock screen can block early instead of the network failing late (SOW D1:
// "two preconditions handled, not discovered late").

import { BASE_FEE, type Horizon } from "@stellar/stellar-sdk";

import { TESTNET_USDC_ISSUER, needsTrustline, type AssetCode } from "@/lib/stellar/assets";
import { hasTrustline } from "@/lib/stellar/horizon";

import { fromStroops, toStroops } from "./amount";

/** Stellar's base reserve, 0.5 XLM on testnet and mainnet. */
export const BASE_RESERVE_STROOPS = 5_000_000n;
/** The lock's two claimants each lock one base reserve against the seller. */
export const LOCK_RESERVE_STROOPS = 2n * BASE_RESERVE_STROOPS;

export type PreflightCheck = {
  id: "sellerAccount" | "buyerAccount" | "buyerTrustline" | "sellerFunds" | "sellerXlm";
  ok: boolean;
  label: string;
  /** Why it failed, in words the seller can act on. */
  detail: string | null;
};

export type LockPreflight = {
  ok: boolean;
  /** The first failing check's detail; null when the lock may go ahead. */
  blockedReason: string | null;
  checks: PreflightCheck[];
};

/** (2 + subentries + sponsoring − sponsored) × base reserve, per Stellar's formula. */
export function minimumBalance(
  account: Pick<Horizon.AccountResponse, "subentry_count" | "num_sponsoring" | "num_sponsored">,
): bigint {
  const entries =
    2n +
    BigInt(account.subentry_count) +
    BigInt(account.num_sponsoring ?? 0) -
    BigInt(account.num_sponsored ?? 0);
  return entries * BASE_RESERVE_STROOPS;
}

/** Balance minus what open offers already promise to sell. */
function spendable(account: Horizon.AccountResponse, code: AssetCode): bigint {
  const line = account.balances.find((b) =>
    code === "XLM"
      ? b.asset_type === "native"
      : "asset_code" in b && b.asset_code === code && b.asset_issuer === TESTNET_USDC_ISSUER,
  );
  if (!line) return 0n;
  const selling = "selling_liabilities" in line ? toStroops(line.selling_liabilities) : 0n;
  return toStroops(line.balance) - selling;
}

const xlm = (stroops: bigint) => `${fromStroops(stroops < 0n ? 0n : stroops)} XLM`;

export function checkLock(params: {
  asset: AssetCode;
  amount: string;
  seller: Horizon.AccountResponse | null;
  buyer: Horizon.AccountResponse | null;
}): LockPreflight {
  const { asset, seller, buyer } = params;
  const amount = toStroops(params.amount);
  const fee = BigInt(BASE_FEE);
  const checks: PreflightCheck[] = [];
  const add = (id: PreflightCheck["id"], ok: boolean, label: string, detail: string) =>
    checks.push({ id, ok, label, detail: ok ? null : detail });

  add(
    "buyerAccount",
    buyer !== null,
    "The buyer's account exists on testnet",
    "The buyer's account does not exist on testnet yet. They need to create and fund it first.",
  );
  if (buyer && needsTrustline(asset)) {
    add(
      "buyerTrustline",
      hasTrustline(buyer, asset),
      `The buyer has a ${asset} trustline`,
      `The buyer needs to add a ${asset} trustline first. Without it the network rejects the claim (op_no_trust).`,
    );
  }

  add(
    "sellerAccount",
    seller !== null,
    "Your account exists on testnet",
    "Your account does not exist on testnet yet. Fund it with Friendbot first.",
  );
  if (seller) {
    const min = minimumBalance(seller);
    const xlmFree = spendable(seller, "XLM") - min;
    if (asset === "XLM") {
      const need = amount + LOCK_RESERVE_STROOPS + fee;
      add(
        "sellerFunds",
        xlmFree >= need,
        `You can cover ${xlm(amount)} plus the ${xlm(LOCK_RESERVE_STROOPS)} reserve and the fee`,
        `You need ${xlm(need)} above your ${xlm(min)} minimum balance, but only ${xlm(xlmFree)} is available.`,
      );
    } else {
      const held = spendable(seller, asset);
      add(
        "sellerFunds",
        held >= amount,
        `You hold ${fromStroops(amount)} ${asset}`,
        `You need ${fromStroops(amount)} ${asset} but hold ${fromStroops(held < 0n ? 0n : held)} ${asset}.`,
      );
      const need = LOCK_RESERVE_STROOPS + fee;
      add(
        "sellerXlm",
        xlmFree >= need,
        `You can cover the ${xlm(LOCK_RESERVE_STROOPS)} reserve and the fee in XLM`,
        `You need ${xlm(need)} above your ${xlm(min)} minimum balance for the reserve and fee, but only ${xlm(xlmFree)} is available.`,
      );
    }
  }

  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, blockedReason: failed?.detail ?? null, checks };
}
