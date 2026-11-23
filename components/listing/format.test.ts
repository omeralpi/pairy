import { describe, expect, it } from "vitest";

import { amountInput } from "@/lib/trade/amount";

import { balanceLabel, belowMinimum, leftLabel, normalizeDecimal } from "./format";

describe("normalizeDecimal (Q-20)", () => {
  it("accepts a decimal comma and a leading dot", () => {
    expect(normalizeDecimal("12,5")).toBe("12.5");
    expect(normalizeDecimal(" .5 ")).toBe("0.5");
    expect(amountInput.safeParse(normalizeDecimal("12,5")).success).toBe(true);
  });

  it("leaves thousands separators for validation to reject", () => {
    expect(normalizeDecimal("1,000")).toBe("1,000");
    expect(amountInput.safeParse(normalizeDecimal("1,000")).success).toBe(false);
    expect(normalizeDecimal("1,0000")).toBe("1.0000");
    expect(normalizeDecimal("1,000.5")).toBe("1,000.5");
    expect(normalizeDecimal("1,000,000")).toBe("1,000,000");
    expect(amountInput.safeParse(normalizeDecimal("1 000")).success).toBe(false);
  });
});

describe("balanceLabel", () => {
  it("never shows more than the account holds", () => {
    // Number().toLocaleString rounded these up to 10,000.00 and 0.01.
    expect(balanceLabel("9999.9999999")).toBe("9,999.99");
    expect(balanceLabel("0.0050000")).toBe("0.00");
    expect(balanceLabel("19.9950000")).toBe("19.99");
  });

  it("groups thousands and pads to cents", () => {
    expect(balanceLabel("1234567.5000000")).toBe("1,234,567.50");
    expect(balanceLabel("100")).toBe("100.00");
    expect(balanceLabel("0.2900000")).toBe("0.29");
  });
});

describe("leftLabel", () => {
  it("says how much of the listing's total is still left, without padding zeros", () => {
    expect(leftLabel({ remainingAmount: "40.0000000", maxAmount: "100.0000000", asset: "USDC" })).toBe("40 of 100 USDC left");
    expect(leftLabel({ remainingAmount: "0.0000000", maxAmount: "250.5000000", asset: "XLM" })).toBe("0 of 250.5 XLM left");
  });
});

describe("belowMinimum", () => {
  it("is true only when less than the minimum is left", () => {
    expect(belowMinimum({ remainingAmount: "9.9999999", minAmount: "10.0000000" })).toBe(true);
    expect(belowMinimum({ remainingAmount: "10.0000000", minAmount: "10.0000000" })).toBe(false);
    expect(belowMinimum({ remainingAmount: "0.0000000", minAmount: "10.0000000" })).toBe(true);
  });
});
