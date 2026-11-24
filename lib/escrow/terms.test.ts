// The term check every escrow passes before anyone funds it (D2 §2): what a
// protected trade's escrow must say, and one problem per field that says
// something else.

import { describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT, MILESTONE_DESCRIPTION, PLATFORM_ACCOUNT, USDC_SAC } from "./config";
import { checkEscrowTerms, expectedTerms, termsOfEscrow, type EscrowTerms } from "./terms";

// The Gate D2 release's parties (scripts/evidence/out/escrow-release-real.json).
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
/** Anyone else. */
const STRANGER = "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN";

const trade = { buyer: BUYER, seller: SELLER, amount: "5.0000000", escrowAdmin: ADMIN };
const expected = expectedTerms(trade);

describe("expectedTerms", () => {
  it("names the buyer as receiver, the seller as approver, release signer and service provider, and the arbiter as the only resolver", () => {
    expect(expected).toEqual({
      admin: ADMIN,
      platform: PLATFORM_ACCOUNT,
      receiver: BUYER,
      approvers: [SELLER],
      releaseSigners: [SELLER],
      disputeResolvers: [ARBITER_ACCOUNT],
      serviceProviders: [SELLER],
      otherRoles: [],
      amountStroops: 50_000_000n,
      platformFeePercent: 0,
      tokenContract: USDC_SAC,
      milestones: [{ description: MILESTONE_DESCRIPTION }],
    });
  });

  it("names another resolver only when a script asks for one", () => {
    expect(expectedTerms(trade, { resolver: STRANGER }).disputeResolvers).toEqual([STRANGER]);
  });

  it("follows SERVICE_PROVIDER_ROLE: the buyer is service provider under DECISIONS 3's fallback", async () => {
    vi.resetModules();
    vi.doMock("./config", async (importOriginal) => ({ ...(await importOriginal<typeof import("./config")>()), SERVICE_PROVIDER_ROLE: "buyer" }));
    try {
      const fallback = await import("./terms");
      expect(fallback.expectedTerms(trade).serviceProviders).toEqual([BUYER]);
      expect(fallback.expectedTerms(trade).approvers).toEqual([SELLER]);
    } finally {
      vi.doUnmock("./config");
      vi.resetModules();
    }
  });
});

describe("checkEscrowTerms", () => {
  it("finds nothing wrong with the expected terms", () => {
    expect(checkEscrowTerms(expected, expected)).toEqual([]);
  });

  // One field changed at a time.
  const changed: { [K in keyof EscrowTerms]: EscrowTerms[K] } = {
    admin: STRANGER,
    platform: STRANGER,
    receiver: SELLER,
    approvers: [BUYER],
    releaseSigners: [STRANGER],
    disputeResolvers: [STRANGER],
    serviceProviders: [BUYER],
    otherRoles: [`observers ${STRANGER}`],
    amountStroops: 50_000_001n,
    platformFeePercent: 1,
    tokenContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    milestones: [{ description: "Delivered" }],
  };
  it.each(Object.keys(changed) as (keyof EscrowTerms)[])("reports exactly one problem when only %s differs", (field) => {
    const problems = checkEscrowTerms({ ...expected, [field]: changed[field] }, expected);
    expect(problems.map((p) => p.field)).toEqual([field]);
  });

  it("refuses a second dispute resolver, even with the arbiter first", () => {
    expect(checkEscrowTerms({ ...expected, disputeResolvers: [ARBITER_ACCOUNT, STRANGER] }, expected)).toEqual([
      {
        field: "disputeResolvers",
        expected: ARBITER_ACCOUNT,
        found: `${ARBITER_ACCOUNT}, ${STRANGER}`,
        message: `The escrow's dispute resolvers are ${ARBITER_ACCOUNT}, ${STRANGER}, not ${ARBITER_ACCOUNT}.`,
      },
    ]);
  });

  it("refuses an extra approver", () => {
    const problems = checkEscrowTerms({ ...expected, approvers: [SELLER, BUYER] }, expected);
    expect(problems.map((p) => p.message)).toEqual([`The escrow's approvers are ${SELLER}, ${BUYER}, not ${SELLER}.`]);
  });

  it("says amounts in USDC and an empty role list as none", () => {
    const problems = checkEscrowTerms({ ...expected, amountStroops: 50_000_001n, releaseSigners: [] }, expected);
    expect(problems.map((p) => p.message)).toEqual([
      `The escrow's release signers are none, not ${SELLER}.`,
      "The escrow's amount is 5.0000001 USDC, not 5 USDC.",
    ]);
  });

  it("lists problems in display order: the SOW's four roles first", () => {
    expect(checkEscrowTerms(changed, expected).map((p) => p.field)).toEqual([
      "receiver",
      "approvers",
      "releaseSigners",
      "disputeResolvers",
      "platformFeePercent",
      "platform",
      "admin",
      "serviceProviders",
      "otherRoles",
      "amountStroops",
      "tokenContract",
      "milestones",
    ]);
  });
});

describe("termsOfEscrow", () => {
  it("reads the terms out of the contract's escrow struct as scValToNative decodes it", () => {
    // The Gate D2 escrow's ["Escrow"] entry after its deploy (scripts/evidence/out/escrow-release-real.json).
    const struct = {
      amount: 50_000_000n,
      description: "Pairy evidence run: release exit, Stellar testnet",
      dispute: { is_disputed: false, reason: "", resolved: false },
      engagement_id: "pairy-evidence-release-1795508874449",
      milestones: [{ approvals: { approval_count: 0, approved_by: [], target: 1 }, description: MILESTONE_DESCRIPTION, evidence: "", status: "pending" }],
      platform_fee: 0,
      receiver_memo: 0,
      released: false,
      roles: {
        admin: ADMIN,
        approvers: [SELLER],
        dispute_resolvers: [ARBITER_ACCOUNT],
        observers: [],
        platform: PLATFORM_ACCOUNT,
        receiver: BUYER,
        release_signers: [SELLER],
        service_providers: [SELLER],
      },
      trustline: { address: USDC_SAC },
    };
    expect(termsOfEscrow(struct)).toEqual(expected);
  });

  // O-21: Pairy never sets an observer or any role outside the seven above, so one that is set is refused.
  const gateStruct = (roles: Record<string, unknown>) => ({
    amount: 50_000_000n,
    milestones: [{ description: MILESTONE_DESCRIPTION }],
    platform_fee: 0,
    roles: {
      admin: ADMIN,
      approvers: [SELLER],
      dispute_resolvers: [ARBITER_ACCOUNT],
      observers: [],
      platform: PLATFORM_ACCOUNT,
      receiver: BUYER,
      release_signers: [SELLER],
      service_providers: [SELLER],
      ...roles,
    },
    trustline: { address: USDC_SAC },
  });

  it("refuses an escrow that names an observer (O-21)", () => {
    expect(checkEscrowTerms(termsOfEscrow(gateStruct({ observers: [STRANGER] })), expected)).toEqual([
      {
        field: "otherRoles",
        expected: "none",
        found: `observers ${STRANGER}`,
        message: `The escrow's roles Pairy never sets are observers ${STRANGER}, not none.`,
      },
    ]);
  });

  it("refuses any other role Pairy never sets, and ignores one left empty (O-21)", () => {
    const problems = checkEscrowTerms(termsOfEscrow(gateStruct({ arbiters: [STRANGER], guardian: STRANGER, auditors: [] })), expected);
    expect(problems.map((p) => p.found)).toEqual([`arbiters ${STRANGER}, guardian ${STRANGER}`]);
    expect(checkEscrowTerms(termsOfEscrow(gateStruct({ auditors: [], note: null })), expected)).toEqual([]);
  });

  it("leaves a missing field missing, so the check reports it", () => {
    const problems = checkEscrowTerms(termsOfEscrow({ amount: 50_000_000n }), expected);
    expect(problems).toHaveLength(10);
    expect(problems[0].message).toBe(`The escrow's receiver is missing, not ${BUYER}.`);
  });
});
