import { describe, expect, it } from "vitest";

import { amountInput } from "./amount";

describe("amountInput", () => {
  it.each(["abc", "1e3", "1,5", ""])("rejects %j with the form message instead of throwing", (v) => {
    const parsed = amountInput.safeParse(v);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual(["Amount must be a number with at most 7 decimals"]);
  });

  it("still applies the bound checks to well-formed input", () => {
    expect(amountInput.safeParse("0").error?.issues.map((i) => i.message)).toEqual(["Amount must be greater than zero"]);
    expect(amountInput.safeParse("922337203686").error?.issues.map((i) => i.message)).toEqual([
      "Amount is larger than a Stellar transaction can carry",
    ]);
    expect(amountInput.safeParse(" 12.5 ").data).toBe("12.5");
  });
});
