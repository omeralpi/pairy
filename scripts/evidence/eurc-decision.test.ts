import { describe, expect, it } from "vitest";

import { DECISION_DAY, decide, passes } from "./eurc-decision";

const treasury = (eurcReceived: string, eurcBalance: string) => ({
  account: "GBNSEA54V6EOBZZOHVC5HSDGHAZDEVJ3YVVB3QHLCQ2EVGZXMUUQLZBB",
  eurcReceived,
  eurcBalance,
});

describe("decide", () => {
  it("issues TEUR on the decision day itself when nothing was received", () => {
    expect(decide(treasury("0.0000000", "0.0000000"), DECISION_DAY)).toMatch(/issue TEUR/);
    expect(decide(treasury("0.0000000", "0.0000000"), "2026-12-02")).toMatch(
      /waiting for Circle's faucet/,
    );
  });

  it("never issues TEUR once EURC has arrived, even after the treasury was spent down", () => {
    expect(decide(treasury("10.0000000", "0.0020560"), "2026-12-04")).toMatch(/^pass/);
    const some = decide(treasury("0.0020560", "0.0020560"), "2026-12-04");
    expect(some).not.toMatch(/TEUR/);
    expect(some).toMatch(/EURC stays the code path/);
  });

  it("passes on what was received, not on what is held", () => {
    expect(passes("9.9999999")).toBe(false);
    expect(passes("10.0000000")).toBe(true);
  });

  it("asks for the treasury first", () => {
    expect(decide(null, "2026-12-04")).toMatch(/create-treasury/);
  });
});
