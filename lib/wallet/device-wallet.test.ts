import { Account, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  WrongPincodeError,
  createDeviceWallet,
  exportDeviceWallet,
  getDeviceWalletPublicKey,
  importDeviceWallet,
  signMessageWithDeviceWallet,
  signTransactionWithDeviceWallet,
} from "./device-wallet";

/** The subset of the Web Storage API that KM's LocalStorageKeyStore uses. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, String(v));
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  clear() {
    this.items.clear();
  }
  dump() {
    return [...this.items.values()].join("\n");
  }
}

const PIN = "correct horse";

function unsignedTx(source: string) {
  return new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(300)
    .build();
}

describe("device wallet", () => {
  it("round-trips create → export → import into a fresh store → sign", async () => {
    const browserA = new MemoryStorage();
    const publicKey = await createDeviceWallet(PIN, browserA);
    expect(await getDeviceWalletPublicKey(browserA)).toBe(publicKey);

    // What leaves the device is only ciphertext: no S... secret anywhere.
    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(publicKey, browserA)));
    expect(Object.keys(backup).sort()).toEqual(["encryptedBlob", "encrypterName", "id", "network", "salt"]);
    expect(JSON.stringify(backup)).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(browserA.dump()).not.toMatch(/S[A-Z2-7]{55}/);

    const browserB = new MemoryStorage();
    await expect(importDeviceWallet(backup, "wrong pincode", browserB)).rejects.toBeInstanceOf(WrongPincodeError);
    expect(await getDeviceWalletPublicKey(browserB)).toBeNull();

    expect(await importDeviceWallet(backup, PIN, browserB)).toBe(publicKey);

    const signedXdr = await signTransactionWithDeviceWallet(publicKey, unsignedTx(publicKey).toXDR(), PIN, browserB);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    expect(signed.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(publicKey).verify(signed.hash(), signed.signatures[0].signature)).toBe(true);

    const sig = await signMessageWithDeviceWallet(publicKey, "hello", PIN, browserB);
    expect(Keypair.fromPublicKey(publicKey).verifyMessage("hello", Buffer.from(sig, "base64"))).toBe(true);
  });

  it("refuses to sign with the wrong pincode", async () => {
    const storage = new MemoryStorage();
    const publicKey = await createDeviceWallet(PIN, storage);
    await expect(
      signTransactionWithDeviceWallet(publicKey, unsignedTx(publicKey).toXDR(), "123456", storage),
    ).rejects.toBeInstanceOf(WrongPincodeError);
    await expect(signMessageWithDeviceWallet(publicKey, "hi", "123456", storage)).rejects.toBeInstanceOf(
      WrongPincodeError,
    );
  });

  it("rejects short pincodes, a second wallet, and files that are not backups", async () => {
    const storage = new MemoryStorage();
    await expect(createDeviceWallet("12345", storage)).rejects.toThrow(/at least 6/);
    await createDeviceWallet(PIN, storage);
    await expect(createDeviceWallet(PIN, storage)).rejects.toThrow(/already holds/);
    await expect(importDeviceWallet({ secret: "S..." }, PIN, new MemoryStorage())).rejects.toThrow(/isn't a Pairy/);
  });
});
