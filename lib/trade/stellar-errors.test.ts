import { TransactionFailedError } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { describeStellarError } from "./stellar-errors";

const refused = (...operations: string[]) =>
  new TransactionFailedError("Transaction submission failed. Server responded: 400 Bad Request", {
    status: 400,
    statusText: "Bad Request",
    data: { extras: { result_codes: { transaction: "tx_failed", operations } } },
  });

describe("describeStellarError", () => {
  it("names the asset whose trustline is missing when it knows it", () => {
    expect(describeStellarError(refused("op_no_trust"), "USDC")).toBe(
      "The receiving account has no USDC trustline, so the network refused it. Add the USDC trustline first, then try again. (op_no_trust)",
    );
    expect(describeStellarError(refused("op_line_full"), "USDC")).toBe(
      "The receiving USDC trustline's limit is too low for this amount. (op_line_full)",
    );
    expect(describeStellarError(refused("op_not_authorized"), "USDC")).toBe(
      "The USDC issuer has not authorized this account's trustline. (op_not_authorized)",
    );
  });

  it("says 'this asset' when the caller does not know which one", () => {
    expect(describeStellarError(refused("op_no_trust"))).toBe(
      "The receiving account has no trustline for this asset, so the network refused it. Add the trustline first, then try again. (op_no_trust)",
    );
    expect(describeStellarError(refused("op_line_full"))).toBe(
      "The receiving trustline for this asset has a limit too low for this amount. (op_line_full)",
    );
    expect(describeStellarError(refused("op_not_authorized"))).toBe(
      "This asset's issuer has not authorized this account's trustline. (op_not_authorized)",
    );
  });

  it("leaves the asset-free messages alone and passes plain errors through", () => {
    expect(describeStellarError(refused("op_underfunded"), "XLM")).toBe(
      "The account does not hold enough of this asset for the transaction. (op_underfunded)",
    );
    expect(describeStellarError(refused("op_success", "op_bogus"))).toBe("Stellar rejected the transaction (op_bogus, tx_failed).");
    expect(describeStellarError(new Error("Get test XLM first."))).toBe("Get test XLM first.");
  });
});
