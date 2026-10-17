import { describe, expect, it } from "vitest";

import { amountInput } from "@/lib/trade/amount";

import { balanceLabel, normalizeDecimal } from "./format";

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
