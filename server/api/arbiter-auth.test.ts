import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { horizon } from "@/lib/stellar/horizon";

import { arbiterAccountNow, arbiterAccountProblems, arbiterAccountState, isArbiterSigner, type ArbiterAccountState } from "./arbiter-auth";

const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
const OLD = "GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV";

/** The arbiter account as Horizon shows it on testnet (O-7, WP-05): its own key listed at weight 0. */
const onHorizon = () => ({
  thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
  signers: [
    { key: OMER, weight: 1, type: "ed25519_public_key" },
    { key: ENSAR, weight: 1, type: "ed25519_public_key" },
    { key: OLD, weight: 0, type: "ed25519_public_key" },
    { key: ARBITER_ACCOUNT, weight: 0, type: "ed25519_public_key" },
  ],
});

const loadAccount = vi.fn();
let clock = Date.parse("2026-12-01T00:00:00Z");

beforeEach(() => {
  // Each test starts more than a minute after the last, so the 60 s cache never carries over.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((clock += 3_600_000));
  loadAccount.mockReset().mockImplementation(async () => onHorizon());
  vi.spyOn(horizon, "loadAccount").mockImplementation(loadAccount);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("arbiterAccountState", () => {
  it("lists the signers that count (weight 1 or more), leaving out the account's own key", async () => {
    await expect(arbiterAccountState()).resolves.toEqual({
      masterWeight: 0,
      thresholds: { low: 2, med: 2, high: 2 },
      signers: [
        { key: OMER, weight: 1 },
        { key: ENSAR, weight: 1 },
      ],
    });
    expect(loadAccount).toHaveBeenCalledWith(ARBITER_ACCOUNT);
  });

  it("reads Horizon at most once a minute", async () => {
    await arbiterAccountState();
    vi.setSystemTime((clock += 59_000));
    await arbiterAccountState();
    expect(loadAccount).toHaveBeenCalledTimes(1);
    vi.setSystemTime((clock += 2_000));
    await arbiterAccountState();
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Horizon cannot be read, and does not remember the failure", async () => {
    loadAccount.mockRejectedValueOnce(new Error("Request failed with status code 503"));
    await expect(arbiterAccountState()).rejects.toThrow(/503/);
    await expect(isArbiterSigner(OMER)).resolves.toBe(true);
  });
});

describe("arbiterAccountNow", () => {
  it("reads Horizon every time, with the account's sequence, and leaves the cache holding what it read", async () => {
    loadAccount.mockImplementation(async () => ({ ...onHorizon(), sequence: "25287766711468033" }));
    await arbiterAccountState();
    expect(await arbiterAccountNow()).toEqual({
      masterWeight: 0,
      thresholds: { low: 2, med: 2, high: 2 },
      signers: [
        { key: OMER, weight: 1 },
        { key: ENSAR, weight: 1 },
      ],
      sequence: "25287766711468033",
    });
    expect(loadAccount).toHaveBeenCalledTimes(2);

    // Ensar removed on Horizon (listed at weight 0): the fresh read shows it, and so does the cached state at once.
    loadAccount.mockImplementation(async () => ({
      ...onHorizon(),
      signers: onHorizon().signers.map((s) => (s.key === ENSAR ? { ...s, weight: 0 } : s)),
      sequence: "25287766711468034",
    }));
    expect(await arbiterAccountNow()).toMatchObject({ signers: [{ key: OMER, weight: 1 }], sequence: "25287766711468034" });
    expect(await isArbiterSigner(ENSAR)).toBe(false);
    expect(loadAccount).toHaveBeenCalledTimes(3);
  });

  it("throws when Horizon cannot be read", async () => {
    loadAccount.mockRejectedValue(new Error("socket hang up"));
    await expect(arbiterAccountNow()).rejects.toThrow("socket hang up");
  });
});

describe("isArbiterSigner", () => {
  it("is true only for a current signer", async () => {
    expect(await isArbiterSigner(OMER)).toBe(true);
    expect(await isArbiterSigner(ENSAR)).toBe(true);
    // A removed signer stays listed at weight 0, and the account's own key is not a signer.
    expect(await isArbiterSigner(OLD)).toBe(false);
    expect(await isArbiterSigner(ARBITER_ACCOUNT)).toBe(false);
    expect(await isArbiterSigner("GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y")).toBe(false);
  });

  it("rejects instead of answering false when Horizon is down", async () => {
    loadAccount.mockRejectedValue(new Error("socket hang up"));
    await expect(isArbiterSigner(OMER)).rejects.toThrow();
    await expect(isArbiterSigner("GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y")).rejects.toThrow();
  });
});

describe("arbiterAccountProblems (O-17's preflight)", () => {
  const real: ArbiterAccountState = {
    masterWeight: 0,
    thresholds: { low: 2, med: 2, high: 2 },
    signers: [
      { key: OMER, weight: 1 },
      { key: ENSAR, weight: 1 },
    ],
  };

  it("passes the real arbiter account", () => {
    expect(arbiterAccountProblems(real)).toEqual([]);
  });

  it("refuses an account whose own key still signs, or a threshold below 2", () => {
    expect(arbiterAccountProblems({ ...real, masterWeight: 1 })).toEqual(["its own key has weight 1"]);
    // A threshold of 1 is also one that a single weight-1 signer meets alone.
    expect(arbiterAccountProblems({ ...real, thresholds: { low: 1, med: 2, high: 2 } })).toEqual([
      "its thresholds are 1/2/2",
      "one signer alone meets a threshold",
    ]);
    expect(arbiterAccountProblems({ ...real, thresholds: { low: 2, med: 2, high: 1 } })).toEqual([
      "its thresholds are 2/2/1",
      "one signer alone meets a threshold",
    ]);
  });

  it("refuses one signer who could act alone, and fewer than two signers", () => {
    expect(arbiterAccountProblems({ ...real, signers: [{ key: OMER, weight: 2 }, { key: ENSAR, weight: 1 }] })).toEqual([
      "one signer alone meets a threshold",
    ]);
    expect(arbiterAccountProblems({ ...real, signers: [{ key: OMER, weight: 1 }] })).toEqual(["it has 1 signer"]);
    expect(arbiterAccountProblems({ ...real, signers: [] })).toEqual(["it has 0 signers"]);
  });
});
