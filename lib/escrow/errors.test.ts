import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { describeEscrowError } from "./errors";

type Problem = { status: number; code: string; detail: string };
const PROBES: Record<string, { response: { body: Problem } }> = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/tw/errors.json"), "utf8"),
).probes;
const WRONG_SUM: Problem = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/tw/resolve-dispute-wrong-sum.json"), "utf8"),
).response.body;

describe("describeEscrowError", () => {
  it("puts each refusal Trustless Work gave on testnet in a sentence of Pairy's own", () => {
    const said = (p: Problem) => describeEscrowError(p);
    const live = Object.fromEntries(Object.values(PROBES).map(({ response: { body } }) => [body.code, said(body)]));
    expect(live).toEqual({
      AUTH_CREDENTIAL_MISSING: "Protected trades are not configured on this server. Nothing was signed.",
      BAD_REQUEST: expect.stringMatching(/^Trustless Work refused Pairy's request \(.+\)\. Nothing was signed\.$/),
      ESCROW_SIGNER_MUST_BE_APPROVER_AND_RELEASE_SIGNER: "Only the seller can release this escrow.",
      ESCROW_DISPUTE_RESOLVER_CANNOT_DISPUTE: "The arbiter cannot open a dispute.",
      ESCROW_NOT_IN_DISPUTE: "This escrow is not in a dispute.",
      ESCROW_NOT_FOUND: "Trustless Work does not know this escrow yet. Try again in a minute.",
    });
    expect(said(WRONG_SUM)).toBe(
      "The payout must be the escrow's whole balance. Prepare the resolution again; the balance may have changed.",
    );
    // The live code, not the contract's error name FIXES quoted (WP-03 judge N4).
    expect(WRONG_SUM.code).toBe("ESCROW_DISTRIBUTIONS_MUST_EQUAL_BALANCE");
  });

  it("explains the release trap Trustless Work's OpenAPI documents (FIXES X-01)", () => {
    expect(describeEscrowError({ status: 409, code: "ESCROW_NOT_COMPLETED", detail: "Escrow not completed" })).toBe(
      "The escrow's milestone is not approved, so it cannot be released yet.",
    );
  });

  it("names the field a bad request was about, from Trustless Work's detail", () => {
    expect(describeEscrowError({ status: 400, code: "BAD_REQUEST", detail: "property extra should not exist" })).toBe(
      "Trustless Work refused Pairy's request (property extra should not exist). Nothing was signed.",
    );
  });

  it("shows Trustless Work's own detail for a code Pairy does not know, and the status when there is none", () => {
    expect(describeEscrowError({ status: 422, code: "ESCROW_SOMETHING_NEW", detail: "Escrow is busy." })).toBe(
      "Trustless Work refused: Escrow is busy.",
    );
    expect(describeEscrowError({ status: 418 })).toBe("Trustless Work refused the request (HTTP 418). Nothing was signed.");
  });
});
