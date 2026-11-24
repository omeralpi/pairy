// Every escrow transaction Trustless Work prepared on testnet (WP-03, S-19)
// must pass the check, and every way of changing what it does must fail it
// (DECISIONS 7). Mutations edit the recorded XDR and re-hash it, as a Trustless
// Work that lies consistently would.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Address, Networks, StrKey, TransactionBuilder, nativeToScVal, xdr, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT, MILESTONE_DESCRIPTION, PLATFORM_ACCOUNT, RESOLVE_WINDOW_SECONDS, USDC_SAC } from "./config";
import type { EscrowTerms } from "./terms";
import {
  decodeEscrowCall,
  deriveEscrowId,
  describeEscrowCall,
  onlyMaxTimeChanged,
  rebuildMaxTime,
  validateEscrowCall,
  type CallExpectation,
} from "./xdr";

type Fixture = { at: string; response: { body: { unsignedXdr: string; txHash: string; contractId?: string } } };
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
/** When the fixture was recorded: inside the 300 s Trustless Work gave it. */
const at = (name: string) => new Date(fixture(name).at);
const decoded = (name: string) => decodeEscrowCall(fixture(name).response.body);

// WP-03's parties and escrows (tests/fixtures/tw/*.json).
const SELLER = "GBMIVYQOGG7M5Z43RKXDFC5AZPBPJOM4VHIL2LZXW6N2GCVC7NUY3NR4";
const BUYER = "GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV";
const PLATFORM = "GACMHHE3UGKORO2X2RPNE74A6L4CQGA6M4JMYTWVRQ2CMLMTQAQRCUSD";
const RESOLVER = "GAGC5NJOBSEGMUS6OAIXB6R5I63JFWZTMVHL2ZXRTLD6336A2KNAG5UI";
const A = { admin: "GDQPAMJYN6WIRVN3FHATKGURUYDPQQGBYBGNQ4HJDTCYFGB7A3BZPQ7J", contractId: "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN" };
const B = { admin: "GDJVGKU2FQCWXMJJ3GVI75JFAZAJSJCEUUR4T4DIVTCD6JNUSD65QPKY", contractId: "CDYH77477CP5QBPM5EDCNHRHQPT6SHVVEHLNK3VV3MTY5TYYCSAPKA7F" };
const C = { admin: "GD3RIWS3JG4LD5JVOU5UWI4BHEDUO2H7GMX5DSGROP3LHH4XMAORA32V", contractId: "CCYHKDCWAKU6HAM33JOJX4D53CRQ6D6RAMEDJYQDT6F7NF5CZ5QRILS5" };
const FACTORY = "CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL";
/** Anyone else: a payee, fee address or resolver Pairy never asked for. */
const STRANGER = "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN";

function terms(admin: string, amountStroops: bigint): EscrowTerms {
  return {
    admin,
    platform: PLATFORM,
    receiver: BUYER,
    approvers: [SELLER],
    releaseSigners: [SELLER],
    disputeResolvers: [RESOLVER],
    serviceProviders: [SELLER],
    otherRoles: [],
    amountStroops,
    platformFeePercent: 0,
    tokenContract: USDC_SAC,
    milestones: [{ description: "Cash handed over" }],
  };
}

/** What Pairy expects of each recorded call. */
const EXPECTED: Record<string, CallExpectation> = {
  deploy: { kind: "deploy", admin: A.admin, contractId: A.contractId, terms: terms(A.admin, 100000000n) },
  "deploy-b": { kind: "deploy", admin: B.admin, contractId: B.contractId, terms: terms(B.admin, 100000000n) },
  "deploy-c": { kind: "deploy", admin: C.admin, contractId: C.contractId, terms: terms(C.admin, 123456789n) },
  fund: { kind: "fund", contractId: A.contractId, seller: SELLER, amountStroops: 100000000n, terms: terms(A.admin, 100000000n) },
  "fund-b": { kind: "fund", contractId: B.contractId, seller: SELLER, amountStroops: 100000000n, terms: terms(B.admin, 100000000n) },
  "fund-c": { kind: "fund", contractId: C.contractId, seller: SELLER, amountStroops: 123456789n, terms: terms(C.admin, 123456789n) },
  "approve-and-release-milestones": { kind: "release", contractId: A.contractId, seller: SELLER },
  dispute: { kind: "dispute", contractId: B.contractId, signer: BUYER },
  "dispute-c": { kind: "dispute", contractId: C.contractId, signer: SELLER },
  "resolve-dispute": { kind: "resolve", contractId: B.contractId, resolver: RESOLVER, recipient: BUYER, amountStroops: 100000000n },
  "resolve-dispute-c": { kind: "resolve", contractId: C.contractId, resolver: RESOLVER, recipient: SELLER, amountStroops: 123456789n },
  // S-19: the same call prepared for a 2-of-2 arbiter account.
  "s19-resolve-buyer": {
    kind: "resolve",
    contractId: "CBW4GYCRER4HR2VQCRRCV4SL3MGD4GA57ITL6EDDY7OCLFPH6JACWUE6",
    resolver: "GCK5PS5XYLBUYUQWZPAPLGZ4OYM35UNIRVIB6QCITWCLBJD4SS3JLSBY",
    recipient: "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN",
    amountStroops: 50000000n,
  },
  "s19-timebounds-30m": {
    kind: "resolve",
    contractId: "CDWMESUXG6MWZYO4IRYUD4U3MT3ODJQCSPVQWZGICSLIA663HFLODFNW",
    resolver: "GCK5PS5XYLBUYUQWZPAPLGZ4OYM35UNIRVIB6QCITWCLBJD4SS3JLSBY",
    recipient: "GDF7V2LLAWVQP7VHZBZ4AWQ3NIE6SV2IYPRFSZBXHNW5STJRLBBKTE3K",
    amountStroops: 50000000n,
  },
};
const check = (name: string, d = decoded(name), now = at(name)) => validateEscrowCall(d, EXPECTED[name], now);

// --- Editing a recorded transaction in its XDR wire form ---------------------------------------

/** The SDK's XDR wire objects, edited in place. */
type Wire = any;
function editedXdr(b64: string, edit: (tx: Wire) => void, passphrase = Networks.TESTNET) {
  const env: Wire = xdr.TransactionEnvelope.fromXDR(b64, "base64").toXdrObject();
  edit(env.v1.tx);
  const unsignedXdr = xdr.TransactionEnvelope.fromXdrObject(env).toXdr("base64");
  const txHash = Buffer.from(TransactionBuilder.fromXDR(unsignedXdr, passphrase).hash()).toString("hex");
  return { unsignedXdr, txHash };
}
const edited = (name: string, edit: (tx: Wire) => void, passphrase = Networks.TESTNET) =>
  editedXdr(fixture(name).response.body.unsignedXdr, edit, passphrase);
const mutated = (name: string, edit: (tx: Wire) => void) => decodeEscrowCall(edited(name, edit));

const hostFn = (tx: Wire) => tx.operations[0].body.invokeHostFunctionOp;
/** The call and its authorization's root: Trustless Work would change both together. */
const calls = (tx: Wire): Wire[] => [hostFn(tx).hostFunction.invokeContract, hostFn(tx).auth[0].rootInvocation.function.contractFn];
const subCalls = (tx: Wire): Wire[] => hostFn(tx).auth[0].rootInvocation.subInvocations;
const scv = (v: unknown, type?: "i128" | "u32" | "string") => nativeToScVal(v, type ? { type } : undefined).toXdrObject();
const address = (a: string) => nativeToScVal(Address.fromString(a)).toXdrObject();
const scAddress = (a: string) => Address.fromString(a).toScAddress().toXdrObject();
/** A field of a contract struct (an ScVal map). */
const field = (struct: Wire, name: string): Wire => struct.map.find((e: Wire) => String(e.key.sym) === name).val;
const setField = (struct: Wire, name: string, val: Wire) => {
  struct.map.find((e: Wire) => String(e.key.sym) === name).val = val;
};
/** An authorized USDC transfer, as an authorization tree node. */
const transfer = (from: string, to: string, amount: bigint): Wire => ({
  function: { type: 0, contractFn: { contractAddress: scAddress(USDC_SAC), functionName: "transfer", args: [address(from), address(to), scv(amount, "i128")] } },
  subInvocations: [],
});

function refused(problems: string[], pattern: RegExp) {
  expect(problems.some((p) => pattern.test(p)), `${pattern} not in:\n${problems.join("\n")}`).toBe(true);
}

describe("decodeEscrowCall", () => {
  it("reads the call, the whole authorization tree and the time bounds", () => {
    expect(decoded("fund")).toEqual({
      network: "testnet",
      hash: fixture("fund").response.body.txHash,
      source: SELLER,
      opCount: 1,
      opType: "invokeHostFunction",
      opSource: null,
      contractId: A.contractId,
      fn: "fund_escrow",
      fee: 149191n,
      memo: "none",
      args: [SELLER, expect.objectContaining({ amount: 100000000n, engagement_id: "pairy-wp03-a-1795460867633" }), 100000000n],
      authRoots: [
        {
          credentials: "source",
          contractId: A.contractId,
          fn: "fund_escrow",
          args: expect.any(Array),
          subInvocations: [{ contractId: USDC_SAC, fn: "transfer", args: [SELLER, A.contractId, 100000000n], subInvocations: [] }],
        },
      ],
      timeBounds: { minTime: 0, maxTime: 1795461214 },
    });
  });

  it("marks a hash that is not the testnet hash of the transaction", () => {
    const fund = fixture("fund").response.body;
    expect(decodeEscrowCall({ ...fund, txHash: "0".repeat(64) }).network).toBe("other");
  });
});

describe("deriveEscrowId (FIXES F-02)", () => {
  it.each(["deploy", "deploy-b", "deploy-c"])("gives %s's escrow address from the factory and the salt, before anything is signed", (name) => {
    expect(deriveEscrowId(decoded(name))).toBe(fixture(name).response.body.contractId);
  });

  it("refuses a call that deploys nothing", () => {
    expect(() => deriveEscrowId(decoded("fund"))).toThrow();
  });
});

describe("validateEscrowCall", () => {
  it.each(Object.keys(EXPECTED))("passes %s as Trustless Work prepared it", (name) => {
    expect(check(name)).toEqual([]);
  });

  describe("refuses, for every kind", () => {
    it("a transaction prepared for another network (the mainnet passphrase)", () => {
      refused(check("fund", decodeEscrowCall(edited("fund", () => {}, Networks.PUBLIC))), /another network/);
    });

    it("an extra operation", () => {
      refused(check("dispute", mutated("dispute", (tx) => tx.operations.push(tx.operations[0]))), /2 operations/);
    });

    it("an operation with its own source account", () => {
      const d = mutated("dispute", (tx) => (tx.operations[0].sourceAccount = { type: 0, ed25519: StrKey.decodeEd25519PublicKey(SELLER) }));
      refused(check("dispute", d), /own source account/);
    });

    it("another signer", () => {
      const d = mutated("fund", (tx) => {
        tx.sourceAccount = { type: 0, ed25519: StrKey.decodeEd25519PublicKey(BUYER) };
        for (const c of calls(tx)) c.args[0] = address(BUYER);
      });
      refused(check("fund", d), new RegExp(`sent from ${BUYER}`));
      refused(check("fund", d), new RegExp(`acts for ${BUYER}`));
    });

    it("another contract", () => {
      const d = mutated("fund", (tx) => calls(tx).forEach((c) => (c.contractAddress = scAddress(B.contractId))));
      refused(check("fund", d), new RegExp(`calls contract ${B.contractId}, not ${A.contractId}`));
    });

    it("another function: the resolver's sweep instead of the resolution", () => {
      const d = mutated("resolve-dispute", (tx) => calls(tx).forEach((c) => (c.functionName = "withdraw_remaining_funds")));
      refused(check("resolve-dispute", d), /calls withdraw_remaining_funds, not resolve_dispute/);
    });

    it("a call of another kind than the step asks for", () => {
      refused(validateEscrowCall(decoded("fund"), EXPECTED["approve-and-release-milestones"], at("fund")), /calls fund_escrow, not approve_and_release_milestones/);
    });

    it("a second authorization root", () => {
      refused(check("dispute", mutated("dispute", (tx) => hostFn(tx).auth.push(hostFn(tx).auth[0]))), /2 authorizations/);
    });

    it("an authorization for a different call than the one made", () => {
      const d = mutated("dispute", (tx) => (calls(tx)[1].args[1] = scv("another reason", "string")));
      refused(check("dispute", d), /authorization is for a different call/);
    });

    it("address credentials instead of the transaction's own signature (FIXES F-04)", () => {
      const d = mutated("resolve-dispute", (tx) => {
        hostFn(tx).auth[0].credentials = {
          type: 1,
          address: { address: scAddress(RESOLVER), nonce: 1n, signatureExpirationLedger: 1, signature: scv(null) },
        };
      });
      refused(check("resolve-dispute", d), /sign inside the call/);
    });

    it("an expired transaction", () => {
      refused(check("fund", decoded("fund"), new Date(at("fund").getTime() + 301_000)), /expired at/);
    });

    it("a longer window than Trustless Work's 300 s (the server-original policy)", () => {
      const d = mutated("resolve-dispute", (tx) => (tx.cond.timeBounds.maxTime += 3600n));
      refused(check("resolve-dispute", d), /stays valid until/);
    });

    it("a transaction that never expires", () => {
      refused(check("dispute", mutated("dispute", (tx) => (tx.cond = { type: 0 }))), /never expires/);
    });

    // Trustless Work never sets a memo; one would be public on chain and missing from the signing screen.
    describe.each([
      ["a text", { type: 1, text: "pay me" }],
      ["an id", { type: 2, id: 7n }],
      ["a hash", { type: 3, hash: new Uint8Array(32).fill(1) }],
    ])("%s memo", (_type, memo) => {
      it.each(["deploy", "fund", "approve-and-release-milestones", "dispute", "resolve-dispute"])("on %s", (name) => {
        refused(check(name, mutated(name, (tx) => (tx.memo = memo))), /carries a memo/);
      });
    });

    it("a fee above ESCROW_XLM_NEED, 2 XLM (O-18)", () => {
      refused(check("fund", mutated("fund", (tx) => (tx.fee = 20_000_001))), /fee can reach 2.0000001 XLM, above the 2 XLM/);
      expect(check("fund", mutated("fund", (tx) => (tx.fee = 20_000_000)))).toEqual([]);
    });
  });

  describe("deploy", () => {
    it("refuses another factory", () => {
      const d = mutated("deploy", (tx) => calls(tx).forEach((c) => (c.contractAddress = scAddress(B.contractId))));
      refused(check("deploy", d), new RegExp(`calls contract ${B.contractId}, not ${FACTORY}`));
    });

    it("refuses an escrow address that is not the one the factory and salt give", () => {
      const d = mutated("deploy", (tx) => {
        for (const c of calls(tx)) c.args[2] = scv(Uint8Array.from(c.args[2].bytes, (b: number, i: number) => (i === 0 ? b ^ 1 : b)));
      });
      refused(check("deploy", d), new RegExp(`returned \\(${A.contractId}\\) is not the one this transaction creates`));
    });

    it("refuses other contract code", () => {
      const d = mutated("deploy", (tx) => {
        for (const c of calls(tx)) {
          c.args[1] = scv(new Uint8Array(32).fill(1));
          c.args[5].vec[1] = scv(new Uint8Array(32).fill(1));
        }
      });
      refused(check("deploy", d), /installs contract code 0101/);
    });

    it("refuses a constructor that names another admin", () => {
      const d = mutated("deploy", (tx) => calls(tx).forEach((c) => (c.args[5].vec[0] = address(STRANGER))));
      refused(check("deploy", d), /constructor arguments/);
    });

    it("refuses an escrow initialised with another resolver", () => {
      const d = mutated("deploy", (tx) => {
        for (const init of [...calls(tx).map((c) => c.args[4].vec[0]), subCalls(tx)[0].function.contractFn.args[0]]) {
          field(field(init, "roles"), "dispute_resolvers").vec[0] = address(STRANGER);
        }
      });
      refused(check("deploy", d), new RegExp(`dispute resolvers are ${STRANGER}, not ${RESOLVER}`));
    });

    it("refuses an escrow that starts in a dispute", () => {
      const d = mutated("deploy", (tx) => {
        for (const init of [...calls(tx).map((c) => c.args[4].vec[0]), subCalls(tx)[0].function.contractFn.args[0]]) {
          setField(field(init, "dispute"), "is_disputed", scv(true));
        }
      });
      refused(check("deploy", d), /already in a dispute/);
    });

    it("refuses an authorization for anything but initialize_escrow on the new escrow", () => {
      const d = mutated("deploy", (tx) => (subCalls(tx)[0].function.contractFn.contractAddress = scAddress(B.contractId)));
      refused(check("deploy", d), new RegExp(`also lets initialize_escrow run on ${B.contractId}`));
    });
  });

  describe("fund", () => {
    it.each([1n, -1n])("refuses an amount %i stroop off", (delta) => {
      const amount = scv(100000000n + delta, "i128");
      const d = mutated("fund", (tx) => {
        for (const c of calls(tx)) c.args[2] = amount;
        subCalls(tx)[0].function.contractFn.args[2] = amount;
      });
      refused(check("fund", d), new RegExp(`moves ${delta > 0 ? "10.0000001" : "9.9999999"} USDC, not 10 USDC`));
    });

    it("refuses an expected_escrow with another resolver (G25)", () => {
      const d = mutated("fund", (tx) => calls(tx).forEach((c) => (field(field(c.args[1], "roles"), "dispute_resolvers").vec[0] = address(STRANGER))));
      refused(check("fund", d), new RegExp(`dispute resolvers are ${STRANGER}, not ${RESOLVER}`));
    });

    it("refuses an expected_escrow that names an observer (O-21)", () => {
      const d = mutated("fund", (tx) => calls(tx).forEach((c) => field(field(c.args[1], "roles"), "observers").vec.push(address(STRANGER))));
      refused(check("fund", d), new RegExp(`roles Pairy never sets are observers ${STRANGER}, not none`));
    });

    it("refuses an escrow that is already released", () => {
      const d = mutated("fund", (tx) => calls(tx).forEach((c) => setField(c.args[1], "released", scv(true))));
      refused(check("fund", d), /already marked released/);
    });

    it("refuses an added transfer(seller → someone else)", () => {
      const d = mutated("fund", (tx) => subCalls(tx).push(transfer(SELLER, STRANGER, 1n)));
      refused(check("fund", d), new RegExp(`also lets transfer run on ${USDC_SAC}`));
    });

    it("refuses a call nested under the transfer", () => {
      const d = mutated("fund", (tx) => subCalls(tx)[0].subInvocations.push(transfer(SELLER, STRANGER, 1n)));
      refused(check("fund", d), /also lets transfer run/);
    });

    it("refuses a fund whose transfer is not authorized", () => {
      refused(check("fund", mutated("fund", (tx) => subCalls(tx).splice(0))), /lacks the expected transfer/);
    });
  });

  describe("release", () => {
    it("refuses a fee address other than the pinned one", () => {
      const d = mutated("approve-and-release-milestones", (tx) => calls(tx).forEach((c) => (c.args[1] = address(STRANGER))));
      refused(check("approve-and-release-milestones", d), new RegExp(`fee to ${STRANGER}`));
    });

    it("refuses other milestones", () => {
      const d = mutated("approve-and-release-milestones", (tx) =>
        calls(tx).forEach((c) => (c.args[2] = { type: 16, vec: [scv(0, "u32"), scv(1, "u32")] })),
      );
      refused(check("approve-and-release-milestones", d), /other milestones/);
    });

    it("refuses an added transfer", () => {
      const d = mutated("approve-and-release-milestones", (tx) => subCalls(tx).push(transfer(SELLER, STRANGER, 1n)));
      refused(check("approve-and-release-milestones", d), /also lets transfer run/);
    });
  });

  describe("dispute", () => {
    it("refuses another reason", () => {
      const d = mutated("dispute", (tx) => calls(tx).forEach((c) => (c.args[1] = scv("Alice Example, +62 811 000", "string"))));
      refused(check("dispute", d), /dispute reason/);
    });
  });

  describe("resolve", () => {
    it("refuses a payout to a third address", () => {
      const d = mutated("resolve-dispute", (tx) => calls(tx).forEach((c) => (c.args[2].map[0].key = address(STRANGER))));
      refused(check("resolve-dispute", d), new RegExp(`pays out 10 USDC to ${STRANGER}, not 10 USDC to ${BUYER}`));
    });

    it("refuses a split", () => {
      const d = mutated("resolve-dispute", (tx) =>
        calls(tx).forEach((c) => {
          c.args[2].map = [
            { key: address(BUYER), val: scv(50000000n, "i128") },
            { key: address(SELLER), val: scv(50000000n, "i128") },
          ];
        }),
      );
      refused(check("resolve-dispute", d), new RegExp(`pays out 5 USDC to ${BUYER} and 5 USDC to ${SELLER}, not 10 USDC to ${BUYER}`));
    });

    it.each([1n, -1n])("refuses an amount %i stroop off", (delta) => {
      const d = mutated("resolve-dispute", (tx) => calls(tx).forEach((c) => (c.args[2].map[0].val = scv(100000000n + delta, "i128"))));
      refused(check("resolve-dispute", d), /pays out/);
    });

    it("refuses a fee address other than the pinned one", () => {
      const d = mutated("resolve-dispute", (tx) => calls(tx).forEach((c) => (c.args[1] = address(STRANGER))));
      refused(check("resolve-dispute", d), new RegExp(`fee to ${STRANGER}`));
    });

    it("refuses another resolver", () => {
      const d = mutated("resolve-dispute", (tx) => {
        tx.sourceAccount = { type: 0, ed25519: StrKey.decodeEd25519PublicKey(STRANGER) };
        for (const c of calls(tx)) c.args[0] = address(STRANGER);
      });
      refused(check("resolve-dispute", d), new RegExp(`sent from ${STRANGER}`));
    });
  });
});

describe("describeEscrowCall", () => {
  it("says in one line what each call does", () => {
    expect(describeEscrowCall(decoded("deploy-c"))).toBe("Create this trade's escrow for 12.3456789 USDC");
    expect(describeEscrowCall(decoded("fund"))).toBe("Fund this trade's escrow with 10 USDC");
    expect(describeEscrowCall(decoded("approve-and-release-milestones"))).toBe(
      "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee",
    );
    expect(describeEscrowCall(decoded("dispute"))).toBe("Open a dispute on this trade's escrow");
    expect(describeEscrowCall(decoded("resolve-dispute-c"))).toBe(
      "Pay this trade's escrow to GBMI…3NR4: 12.3086419 USDC after Trustless Work's 0.3% fee",
    );
  });

  it("names any other call plainly", () => {
    const d = mutated("dispute", (tx) => calls(tx).forEach((c) => (c.functionName = "withdraw_remaining_funds")));
    expect(describeEscrowCall(d)).toBe("Call withdraw_remaining_funds on CDYH…KA7F");
  });
});

// --- O-17: the arbiter's resolve, re-timed before anyone signs -------------------------------

type Retimed = {
  at: string;
  hash?: string;
  signatures?: { signedAt: string }[];
  response: { body: { unsignedXdr: string; txHash: string } };
  rebuilt: { unsignedXdr: string; compare: { timeBounds: { after: { maxTime: string } }; txHash: [string, string] } };
};
const read = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
// S-19's real rebuilds: 30 min (landed as 49f399b9), and 24 h for two arbiters. Late-B also raised the fee cap.
const window30m: Retimed = read("s19-timebounds-30m");
const [lateA, lateB]: Retimed[] = read("s19-timebounds-24h-late").envelopes;
const lateAExpected: CallExpectation = {
  kind: "resolve",
  contractId: "CAGVTIJIRUKXPPI2LDUZZ2KJENMZRBBLVRCF4WSLLWGNSC32K5HRQ3CX",
  resolver: "GCK5PS5XYLBUYUQWZPAPLGZ4OYM35UNIRVIB6QCITWCLBJD4SS3JLSBY",
  recipient: "GAXOU5PDAF4P7435N7JDDKJYYSVGSWRNTZI3CWVZPZGPORQ5TUTX5UJN",
  amountStroops: 50000000n,
};
const rebuiltMaxTime = (r: Retimed) => Number(r.rebuilt.compare.timeBounds.after.maxTime);
const seconds = (d: string) => Math.floor(new Date(d).getTime() / 1000);

describe("rebuildMaxTime and onlyMaxTimeChanged (O-17)", () => {
  it("rebuild Trustless Work's resolve to the probe's maxTime byte for byte, with the hash that landed", () => {
    expect(rebuildMaxTime(window30m.response.body.unsignedXdr, rebuiltMaxTime(window30m))).toEqual({
      unsignedXdr: window30m.rebuilt.unsignedXdr,
      txHash: window30m.rebuilt.compare.txHash[1], // 49f399b9…, on testnet
    });
    expect(rebuildMaxTime(lateA.response.body.unsignedXdr, rebuiltMaxTime(lateA))).toEqual({
      unsignedXdr: lateA.rebuilt.unsignedXdr,
      txHash: lateA.hash,
    });
  });

  it("re-time only a transaction nobody has signed", () => {
    const signed = read("s19-resolve-buyer").twoSignatures.mergedSignedXdr;
    expect(() => rebuildMaxTime(signed, rebuiltMaxTime(window30m))).toThrow(/signed/);
  });

  it("accept the probe's rebuilds, where only maxTime changed", () => {
    expect(onlyMaxTimeChanged(window30m.response.body.unsignedXdr, window30m.rebuilt.unsignedXdr)).toBe(true);
    expect(onlyMaxTimeChanged(lateA.response.body.unsignedXdr, lateA.rebuilt.unsignedXdr)).toBe(true);
  });

  it("refuse late-B, which also raised the resource-fee cap", () => {
    expect(onlyMaxTimeChanged(lateB.response.body.unsignedXdr, lateB.rebuilt.unsignedXdr)).toBe(false);
  });

  it.each<[string, (tx: Wire) => void]>([
    ["the source", (tx) => (tx.sourceAccount = { type: 0, ed25519: StrKey.decodeEd25519PublicKey(STRANGER) })],
    ["the fee", (tx) => (tx.fee += 1)],
    ["the sequence number", (tx) => (tx.seqNum += 1n)],
    ["the memo", (tx) => (tx.memo = { type: 1, text: "x" })],
    ["minTime", (tx) => (tx.cond.timeBounds.minTime = 1n)],
    ["the operation", (tx) => (calls(tx)[0].args[2].map[0].key = address(STRANGER))],
    ["the authorization", (tx) => (calls(tx)[1].args[2].map[0].key = address(STRANGER))],
    ["the Soroban data", (tx) => (tx.ext.sorobanData.resourceFee += 1n)],
  ])("refuse a rebuild that also changes %s", (_what, edit) => {
    const changed = editedXdr(window30m.rebuilt.unsignedXdr, edit).unsignedXdr;
    expect(onlyMaxTimeChanged(window30m.response.body.unsignedXdr, changed)).toBe(false);
  });

  it("refuse a rebuild through TransactionBuilder.cloneFrom, which drops the Soroban data in SDK 17.2.1", () => {
    const tw = TransactionBuilder.fromXDR(window30m.response.body.unsignedXdr, Networks.TESTNET) as Transaction;
    const cloned = TransactionBuilder.cloneFrom(tw, { timebounds: { minTime: 0, maxTime: rebuiltMaxTime(window30m) } }).build();
    expect(onlyMaxTimeChanged(window30m.response.body.unsignedXdr, cloned.toXDR())).toBe(false);
  });

  it("refuse another transaction altogether", () => {
    expect(onlyMaxTimeChanged(window30m.response.body.unsignedXdr, fixture("s19-resolve-buyer").response.body.unsignedXdr)).toBe(false);
  });
});

describe("the resolve's time policy (O-17)", () => {
  const tw = window30m.response.body;
  const now = at("s19-timebounds-30m");
  const prepared = seconds(window30m.at);
  const policy = (timePolicy: "server-original" | "browser-rebuilt", e = EXPECTED["s19-timebounds-30m"]) => ({ ...e, timePolicy }) as CallExpectation;
  const retimed = (maxTime: number) => decodeEscrowCall(rebuildMaxTime(tw.unsignedXdr, maxTime));

  it("server-original: Trustless Work's own 300 s passes, a re-timed resolve does not", () => {
    expect(validateEscrowCall(decodeEscrowCall(tw), policy("server-original"), now)).toEqual([]);
    refused(validateEscrowCall(retimed(rebuiltMaxTime(window30m)), policy("server-original"), now), /stays valid until/);
  });

  it("browser-rebuilt: the probe's 30 min and 24 h rebuilds pass, and so does RESOLVE_WINDOW_SECONDS", () => {
    const rebuilt30m = { unsignedXdr: window30m.rebuilt.unsignedXdr, txHash: window30m.rebuilt.compare.txHash[1] };
    expect(validateEscrowCall(decodeEscrowCall(rebuilt30m), policy("browser-rebuilt"), now)).toEqual([]);
    // Late-A, checked when its first signer signed.
    const rebuilt24h = { unsignedXdr: lateA.rebuilt.unsignedXdr, txHash: lateA.hash! };
    expect(validateEscrowCall(decodeEscrowCall(rebuilt24h), policy("browser-rebuilt", lateAExpected), new Date(lateA.signatures![0].signedAt))).toEqual([]);
    expect(validateEscrowCall(retimed(prepared + RESOLVE_WINDOW_SECONDS), policy("browser-rebuilt"), now)).toEqual([]);
  });

  it("browser-rebuilt: at least 10 minutes and at most 24 hours", () => {
    refused(validateEscrowCall(retimed(prepared + 5 * 60), policy("browser-rebuilt"), now), /less than 10 minutes/);
    refused(validateEscrowCall(retimed(prepared + 25 * 3600), policy("browser-rebuilt"), now), /more than 24 hours/);
    refused(validateEscrowCall(decodeEscrowCall(tw), policy("browser-rebuilt"), now), /less than 10 minutes/);
    expect(validateEscrowCall(retimed(prepared + 10 * 60), policy("browser-rebuilt"), now)).toEqual([]);
    expect(validateEscrowCall(retimed(prepared + 24 * 3600), policy("browser-rebuilt"), now)).toEqual([]);
  });
});

describe("the Gate D2 release (WP-11): Pairy's own platform and arbiter, and the pinned factory, code and fee address", () => {
  // Recorded by scripts/evidence/escrow-exits.ts release --arbiter=real. The parties
  // are the ones Pairy asked Trustless Work for; the platform, resolver, token and
  // milestone are Pairy's constants, so a call that differs from them is refused.
  type DeployRequest = { signer: string; roles: { approvers: string[]; receiver: string } };
  const gate = (step: string) => `gate-d2-${step}`;
  const parties = () => {
    const f = fixture(gate("deploy")) as Fixture & { request: { body: DeployRequest } };
    const { signer, roles } = f.request.body;
    return { admin: signer, seller: roles.approvers[0], buyer: roles.receiver, contractId: f.response.body.contractId! };
  };
  const expectation = (step: string): CallExpectation => {
    const { admin, seller, buyer, contractId } = parties();
    const amountStroops = 50_000_000n; // the script's 5 USDC
    const terms: EscrowTerms = {
      admin,
      platform: PLATFORM_ACCOUNT,
      receiver: buyer,
      approvers: [seller],
      releaseSigners: [seller],
      disputeResolvers: [ARBITER_ACCOUNT],
      serviceProviders: [seller],
      otherRoles: [],
      amountStroops,
      platformFeePercent: 0,
      tokenContract: USDC_SAC,
      milestones: [{ description: MILESTONE_DESCRIPTION }],
    };
    if (step === "deploy") return { kind: "deploy", admin, contractId, terms };
    if (step === "fund") return { kind: "fund", contractId, seller, amountStroops, terms };
    return { kind: "release", contractId, seller };
  };

  it.each(["deploy", "fund", "release"])("passes the %s as Trustless Work prepared it", (step) => {
    expect(validateEscrowCall(decoded(gate(step)), expectation(step), at(gate(step)))).toEqual([]);
  });
});

describe("while the factory, wasm hash and fee address are unpinned (FIXES F-02, F-10)", () => {
  it("checks the fee address and the wasm hash only once pinned, and logs the factory it derived from", async () => {
    vi.resetModules();
    vi.doMock("./config", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./config")>()),
      TW_FACTORY_CONTRACT_ID: null,
      TW_ESCROW_WASM_HASH: null,
      TW_FEE_ADDRESS: null,
    }));
    const unpinned = await import("./xdr");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const release = unpinned.decodeEscrowCall(
        edited("approve-and-release-milestones", (tx) => calls(tx).forEach((c) => (c.args[1] = address(STRANGER)))),
      );
      expect(unpinned.validateEscrowCall(release, EXPECTED["approve-and-release-milestones"], at("approve-and-release-milestones"))).toEqual([]);

      const deploy = unpinned.decodeEscrowCall(
        edited("deploy", (tx) => {
          for (const c of calls(tx)) {
            c.args[1] = scv(new Uint8Array(32).fill(1));
            c.args[5].vec[1] = scv(new Uint8Array(32).fill(1));
          }
        }),
      );
      expect(unpinned.validateEscrowCall(deploy, EXPECTED.deploy, at("deploy"))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ evt: "escrow.factory_unpinned", factory: FACTORY }));
    } finally {
      warn.mockRestore();
    }
  });
});

// --- WP-15: both dispute exits, resolved by the test 2-of-2 one at a time ----------------------
// Recorded by scripts/evidence/escrow-exits.ts dispute-<side> --arbiter=test: the side that
// opened the dispute is paid, as D2 §9 runs the two exits.

describe.each(["buyer", "seller"] as const)("the dispute exit to the %s (WP-15, test 2-of-2)", (side) => {
  const dispute = read(`exits-test-dispute-${side}`);
  const r = read(`exits-test-resolve-${side}`);
  const expectation: CallExpectation = {
    kind: "resolve",
    contractId: r.escrow.contractId,
    resolver: r.arbiter.account,
    recipient: r.escrow.recipient,
    amountStroops: BigInt(r.sacBalanceStroops),
  };

  it("was opened by that side, with Pairy's reason", () => {
    expect(dispute.request.body.signer).toBe(r.escrow[side]);
    const d = decodeEscrowCall(dispute.response.body);
    expect(validateEscrowCall(d, { kind: "dispute", contractId: r.escrow.contractId, signer: r.escrow[side] }, new Date(dispute.at))).toEqual([]);
  });

  it("pays the whole escrow to that side as Trustless Work prepared it, authorized by the arbiter's own signature (F-04)", () => {
    expect(r.escrow.recipient).toBe(r.escrow[side]);
    const d = decodeEscrowCall(r.response.body);
    expect(validateEscrowCall(d, { ...expectation, timePolicy: "server-original" }, new Date(r.at))).toEqual([]);
    expect(d.authRoots.map((a) => a.credentials)).toEqual(["source"]);
  });

  it("uses the arbiter's next sequence number and pays out the escrow's USDC SAC balance (F-03, X-07)", () => {
    const tx = TransactionBuilder.fromXDR(r.response.body.unsignedXdr, Networks.TESTNET) as Transaction;
    expect(BigInt(tx.sequence)).toBe(BigInt(r.arbiter.sequence) + 1n);
    expect(r.sacBalanceStroops).toBe("50000000");
    expect(r.request.body.distributions).toEqual([{ address: r.escrow.recipient, amount: 5 }]);
  });

  it("was re-timed to Horizon time + RESOLVE_WINDOW_SECONDS, maxTime only, and passes the browser's check (O-17)", () => {
    const maxTime = r.rebuilt.horizonTime + RESOLVE_WINDOW_SECONDS;
    expect(rebuildMaxTime(r.response.body.unsignedXdr, maxTime)).toEqual({ unsignedXdr: r.rebuilt.unsignedXdr, txHash: r.rebuilt.txHash });
    expect(onlyMaxTimeChanged(r.response.body.unsignedXdr, r.rebuilt.unsignedXdr)).toBe(true);
    const checkedAt = new Date(r.rebuilt.horizonTime * 1000);
    expect(validateEscrowCall(decodeEscrowCall(r.rebuilt), { ...expectation, timePolicy: "browser-rebuilt" }, checkedAt)).toEqual([]);
  });

  it("landed as the re-timed transaction, not as Trustless Work's", () => {
    expect(r.landed.hash).toBe(r.rebuilt.txHash);
    expect(r.landed.hash).not.toBe(r.response.body.txHash);
    expect(decodeEscrowCall({ unsignedXdr: r.landed.signedXdr, txHash: r.landed.hash }).timeBounds).toEqual({
      minTime: 0,
      maxTime: r.rebuilt.horizonTime + RESOLVE_WINDOW_SECONDS,
    });
  });
});
