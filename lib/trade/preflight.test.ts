import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET_USDC_ISSUER } from "@/lib/stellar/assets";

import { fiatTotal } from "./amount";
import { checkLock, minimumBalance } from "./preflight";

function account(opts: {
  xlm: string;
  usdc?: string;
  subentries?: number;
  sponsoring?: number;
  sponsored?: number;
  xlmSelling?: string;
  usdcLimit?: string;
  usdcAuthorized?: boolean;
}): Horizon.AccountResponse {
  const balances: object[] = [
    { asset_type: "native", balance: opts.xlm, selling_liabilities: opts.xlmSelling ?? "0.0000000" },
  ];
  if (opts.usdc !== undefined) {
    balances.push({
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: TESTNET_USDC_ISSUER,
      balance: opts.usdc,
      limit: opts.usdcLimit ?? "922337203685.4775807",
      is_authorized: opts.usdcAuthorized ?? true,
      selling_liabilities: "0.0000000",
      buying_liabilities: "0.0000000",
    });
  }
  return {
    balances,
    subentry_count: opts.subentries ?? (opts.usdc !== undefined ? 1 : 0),
    num_sponsoring: opts.sponsoring ?? 0,
    num_sponsored: opts.sponsored ?? 0,
  } as unknown as Horizon.AccountResponse;
}

const ids = (r: ReturnType<typeof checkLock>) => r.checks.map((c) => [c.id, c.ok]);

describe("minimumBalance", () => {
  it("is (2 + subentries + sponsoring − sponsored) × 0.5 XLM", () => {
    expect(minimumBalance({ subentry_count: 0, num_sponsoring: 0, num_sponsored: 0 })).toBe(10_000_000n);
    expect(minimumBalance({ subentry_count: 3, num_sponsoring: 2, num_sponsored: 1 })).toBe(30_000_000n);
  });
});

describe("checkLock before the buyer can actually receive (S-5, N-3, T-4)", () => {
  const seller = account({ xlm: "10", usdc: "100" });

  it("blocks when the issuer has not authorized the buyer's USDC trustline", () => {
    const r = checkLock({ asset: "USDC", amount: "25", seller, buyer: account({ xlm: "5", usdc: "0", usdcAuthorized: false }) });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/not authorized/);
  });

  it("blocks when the buyer's trustline limit leaves no room for the amount", () => {
    const r = checkLock({ asset: "USDC", amount: "25", seller, buyer: account({ xlm: "5", usdc: "0", usdcLimit: "1" }) });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/limit/);
  });

  it("blocks a second lock when one for this trade is already on Stellar", () => {
    const r = checkLock({ asset: "XLM", amount: "1", seller: account({ xlm: "50" }), buyer: account({ xlm: "5" }), existingLock: true });
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ id: "noExistingLock", ok: false });
  });
});

describe("checkLock", () => {
  it("passes an XLM lock the seller can afford with the reserve and fee on top", () => {
    // min 1 XLM + 25 XLM + 1 XLM reserve (2 claimants) + the 10,000-stroop fee
    // bid twice: the lock now, and the take-back if the buyer never claims.
    const r = checkLock({ asset: "XLM", amount: "25", seller: account({ xlm: "27.0020000" }), buyer: account({ xlm: "5" }) });
    expect(r).toMatchObject({ ok: true, blockedReason: null });
    expect(ids(r)).toEqual([
      ["buyerAccount", true],
      ["sellerAccount", true],
      ["sellerFunds", true],
    ]);
  });

  it("blocks an XLM lock one stroop short, counting offers' selling liabilities", () => {
    const short = checkLock({ asset: "XLM", amount: "25", seller: account({ xlm: "27.0019999" }), buyer: account({ xlm: "5" }) });
    expect(short.ok).toBe(false);
    expect(short.blockedReason).toMatch(/You need 26.002 XLM above your 1 XLM minimum balance/);

    const offers = checkLock({
      asset: "XLM",
      amount: "25",
      seller: account({ xlm: "40", xlmSelling: "13" }),
      buyer: account({ xlm: "5" }),
    });
    expect(offers.ok).toBe(false);
  });

  it("blocks a USDC lock until the buyer has the trustline", () => {
    const r = checkLock({
      asset: "USDC",
      amount: "10",
      seller: account({ xlm: "10", usdc: "50" }),
      buyer: account({ xlm: "5" }),
    });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/^The buyer needs to add a USDC trustline first/);
    expect(
      checkLock({ asset: "USDC", amount: "10", seller: account({ xlm: "10", usdc: "50" }), buyer: account({ xlm: "5", usdc: "0" }) }).ok,
    ).toBe(true);
  });

  it("checks the USDC balance and the XLM headroom separately", () => {
    const buyer = account({ xlm: "5", usdc: "0" });
    // 1 trustline subentry → 1.5 XLM minimum; needs 1.00001 XLM on top.
    const lowXlm = checkLock({ asset: "USDC", amount: "10", seller: account({ xlm: "2.5", usdc: "50" }), buyer });
    expect(ids(lowXlm)).toContainEqual(["sellerFunds", true]);
    expect(ids(lowXlm)).toContainEqual(["sellerXlm", false]);
    expect(lowXlm.blockedReason).toMatch(/1.5 XLM minimum balance/);

    const lowUsdc = checkLock({ asset: "USDC", amount: "10", seller: account({ xlm: "10", usdc: "9.9999999" }), buyer });
    expect(ids(lowUsdc)).toContainEqual(["sellerFunds", false]);
    expect(lowUsdc.blockedReason).toBe("You need 10 USDC but hold 9.9999999 USDC.");
  });

  it("reports missing accounts", () => {
    const r = checkLock({ asset: "USDC", amount: "10", seller: null, buyer: null });
    expect(ids(r)).toEqual([
      ["buyerAccount", false],
      ["sellerAccount", false],
    ]);
    expect(r.blockedReason).toMatch(/buyer's account does not exist/);
  });
});

describe("fiatTotal", () => {
  it("multiplies exactly and rounds half-up to cents", () => {
    expect(fiatTotal("25.5", "4.125")).toBe("105.19");
    expect(fiatTotal("0.1", "0.1")).toBe("0.01");
    expect(fiatTotal("9999999999999.9999999", "9999.9999")).toBe("99999999000000000.00") // 10^17 − 10^9 − 0.000999…;
  });
});
