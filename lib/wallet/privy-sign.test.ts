import { createHash } from "node:crypto";

import { Account, Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { buildClaimTransaction } from "@/lib/stellar/settlement";

import {
  findStellarWallet,
  hexSignatureToBytes,
  sep53Hash,
  signMessageWithRawSigner,
  signXdrWithRawSigner,
  txHashHex,
} from "./privy-sign";

const kp = Keypair.random();
const tx = () => buildClaimTransaction(new Account(kp.publicKey(), "1"), `00000000${"ab".repeat(32)}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A local key standing in for Privy: like signRawHash, it signs exactly the 32 bytes it is given. */
const rawSigner = (key = kp) => async (hash32: Uint8Array) => new Uint8Array(key.sign(Buffer.from(hash32)));

describe("txHashHex", () => {
  it("is 0x + the testnet transaction hash, which the public-network passphrase would change", () => {
    const t = tx();
    expect(txHashHex(t.toXDR())).toBe(`0x${hex(t.hash())}`);
    const onPublic = TransactionBuilder.fromXDR(t.toXDR(), Networks.PUBLIC) as Transaction;
    expect(txHashHex(t.toXDR())).not.toBe(`0x${hex(onPublic.hash())}`);
  });

  it("refuses a fee-bump envelope", () => {
    const inner = tx();
    inner.sign(kp);
    const bump = TransactionBuilder.buildFeeBumpTransaction(kp.publicKey(), "20000", inner, Networks.TESTNET);
    expect(() => txHashHex(bump.toXDR())).toThrow(/fee bump/i);
  });
});

describe("hexSignatureToBytes", () => {
  it("decodes 0x + 128 hex characters to the 64 signature bytes", () => {
    const sig = kp.sign(Buffer.alloc(32, 7));
    expect(Buffer.from(hexSignatureToBytes(`0x${hex(sig)}`))).toEqual(Buffer.from(sig));
  });

  it("refuses 63 or 65 bytes, a missing 0x prefix and non-hex input", () => {
    expect(() => hexSignatureToBytes(`0x${"ab".repeat(63)}`)).toThrow(/128 hex/);
    expect(() => hexSignatureToBytes(`0x${"ab".repeat(65)}`)).toThrow(/128 hex/);
    expect(() => hexSignatureToBytes("ab".repeat(64))).toThrow(/128 hex/);
    expect(() => hexSignatureToBytes(`0x${"zz".repeat(64)}`)).toThrow(/128 hex/);
  });
});

describe("signXdrWithRawSigner", () => {
  it("returns XDR that parses with one signature valid for the testnet hash", async () => {
    const t = tx();
    const signedXdr = await signXdrWithRawSigner(t.toXDR(), kp.publicKey(), rawSigner());
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    expect(hex(signed.hash())).toBe(hex(t.hash()));
    expect(signed.signatures).toHaveLength(1);
    // ed25519 is deterministic: the SDK's own signing of the same key gives the same envelope.
    t.sign(kp);
    expect(signedXdr).toBe(t.toXDR());
  });

  it("throws Invalid signature when the signer signed a different hash, before anything can be sent", async () => {
    const wrongHash = async (hash32: Uint8Array) =>
      new Uint8Array(kp.sign(createHash("sha256").update(Buffer.from(hash32)).digest()));
    await expect(signXdrWithRawSigner(tx().toXDR(), kp.publicKey(), wrongHash)).rejects.toThrow(/Invalid signature/);
  });

  it("throws Invalid signature when another key signed", async () => {
    await expect(signXdrWithRawSigner(tx().toXDR(), kp.publicKey(), rawSigner(Keypair.random()))).rejects.toThrow(
      /Invalid signature/,
    );
  });
});

describe("sep53Hash and signMessageWithRawSigner", () => {
  const message = "Sign in to Pairy (Stellar testnet).\nNonce: abc";

  it("sep53Hash is sha256 of the SEP-53 prefix followed by the message", () => {
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), Buffer.from(message, "utf8")]))
      .digest();
    expect(Buffer.from(sep53Hash(message))).toEqual(expected);
  });

  it("gives a base64 signature Keypair.verifyMessage accepts, as the unchanged auth.verify checks it", async () => {
    const signature = await signMessageWithRawSigner(message, rawSigner());
    expect(signature).toHaveLength(88); // 64 bytes in base64, within auth.verify's max(200)
    expect(kp.verifyMessage(message, Buffer.from(signature, "base64"))).toBe(true);
    expect(Keypair.random().verifyMessage(message, Buffer.from(signature, "base64"))).toBe(false);
  });
});

describe("findStellarWallet", () => {
  // Field names from S-01's WalletWithMetadata type (WP-06); the anonymised
  // capture lib/wallet/__fixtures__/privy-user.json follows once HX-1 runs.
  const wallet = (address: string, firstVerifiedAt: string | Date | null, chainType = "stellar") => ({
    type: "wallet",
    address,
    chainType,
    walletClientType: "privy",
    connectorType: "embedded",
    id: "redacted",
    imported: false,
    walletIndex: 0,
    firstVerifiedAt,
    latestVerifiedAt: firstVerifiedAt,
  });
  const email = { type: "email", address: "redacted", firstVerifiedAt: "2026-11-24T10:00:00.000Z" };

  it("returns the Stellar wallet's address, skipping the email account and other chains", () => {
    const accounts = [email, wallet("0xabc", "2026-11-24T10:00:01.000Z", "ethereum"), wallet("GSTELLAR", "2026-11-24T10:00:02.000Z")];
    expect(findStellarWallet(accounts)).toEqual({ address: "GSTELLAR" });
  });

  it("is null when there is no Stellar wallet, or no list at all", () => {
    expect(findStellarWallet([email])).toBeNull();
    expect(findStellarWallet([])).toBeNull();
    expect(findStellarWallet(undefined)).toBeNull();
    expect(findStellarWallet(null)).toBeNull();
    expect(findStellarWallet("GSTELLAR")).toBeNull();
  });

  it("picks the oldest when there are two, whether firstVerifiedAt is a Date or an ISO string", () => {
    const older = wallet("GOLDER", new Date("2026-11-20T00:00:00.000Z"));
    const newer = wallet("GNEWER", "2026-11-24T00:00:00.000Z");
    expect(findStellarWallet([newer, older])).toEqual({ address: "GOLDER" });
    expect(findStellarWallet([older, newer])).toEqual({ address: "GOLDER" });
    expect(findStellarWallet([wallet("GUNDATED", null), older])).toEqual({ address: "GOLDER" });
  });
});
