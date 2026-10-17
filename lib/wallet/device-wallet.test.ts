import { Account, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { KeyManager, KeyType, LocalStorageKeyStore, ScryptEncrypter } from "@stellar/typescript-wallet-sdk-km";
import { describe, expect, it } from "vitest";

import {
  WrongPincodeError,
  createDeviceWallet,
  exportDeviceWallet,
  getDeviceWalletPublicKey,
  importDeviceWallet,
  replaceDeviceWallet,
  signMessageWithDeviceWallet,
  signTransactionWithDeviceWallet,
} from "./device-wallet";
import { lockBackupProblem } from "./backup";

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

  it("unlocks with the same pincode typed in another Unicode form (NFC vs NFD)", async () => {
    const nfc = "café şifre";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    const browserA = new MemoryStorage();
    const publicKey = await createDeviceWallet(nfc, browserA);
    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(publicKey, browserA)));
    // The same pincode, decomposed: what another keyboard or a paste can produce.
    expect(await importDeviceWallet(backup, nfd, new MemoryStorage())).toBe(publicKey);
    const sig = await signMessageWithDeviceWallet(publicKey, "hi", nfd, browserA);
    expect(Keypair.fromPublicKey(publicKey).verifyMessage("hi", Buffer.from(sig, "base64"))).toBe(true);
    await signTransactionWithDeviceWallet(publicKey, unsignedTx(publicKey).toXDR(), nfd, browserA);
  });

  it("still unlocks a wallet whose pincode was stored decomposed", async () => {
    const nfd = "café şifre".normalize("NFD");
    const storage = new MemoryStorage();
    // A wallet made before pincodes were normalized: encrypted under the raw string.
    const store = new LocalStorageKeyStore();
    void store.configure({ storage, prefix: "pairy-keys" });
    const km = new KeyManager({ keyStore: store, defaultNetworkPassphrase: Networks.TESTNET });
    km.registerEncrypter(ScryptEncrypter);
    const kp = Keypair.random();
    const publicKey = kp.publicKey();
    await km.storeKey({
      key: { id: publicKey, publicKey, privateKey: kp.secret(), type: KeyType.plaintextKey, network: Networks.TESTNET },
      password: nfd,
      encrypterName: ScryptEncrypter.name,
    });
    const sig = await signMessageWithDeviceWallet(publicKey, "hi", nfd, storage);
    expect(Keypair.fromPublicKey(publicKey).verifyMessage("hi", Buffer.from(sig, "base64"))).toBe(true);
    await signTransactionWithDeviceWallet(publicKey, unsignedTx(publicKey).toXDR(), nfd, storage);
  });

  it("rejects short pincodes, a second wallet, and files that are not backups", async () => {
    const storage = new MemoryStorage();
    await expect(createDeviceWallet("12345", storage)).rejects.toThrow(/at least 6/);
    await createDeviceWallet(PIN, storage);
    await expect(createDeviceWallet(PIN, storage)).rejects.toThrow(/already holds/);
    await expect(importDeviceWallet({ secret: "S..." }, PIN, new MemoryStorage())).rejects.toThrow(/isn't a Pairy/);
  });

  it("swaps in another backup only once its pincode works (Q-9)", async () => {
    const other = new MemoryStorage();
    const otherKey = await createDeviceWallet("other pincode", other);
    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(otherKey, other)));

    const storage = new MemoryStorage();
    const mine = await createDeviceWallet(PIN, storage);
    await expect(importDeviceWallet(backup, "other pincode", storage)).rejects.toThrow(/already holds/);

    await expect(replaceDeviceWallet(backup, "wrong pincode", storage)).rejects.toBeInstanceOf(WrongPincodeError);
    expect(await getDeviceWalletPublicKey(storage)).toBe(mine);
    await expect(replaceDeviceWallet({ nope: true }, PIN, storage)).rejects.toThrow(/isn't a Pairy/);
    expect(await getDeviceWalletPublicKey(storage)).toBe(mine);

    expect(await replaceDeviceWallet(backup, "other pincode", storage)).toBe(otherKey);
    expect(await getDeviceWalletPublicKey(storage)).toBe(otherKey);
    await expect(exportDeviceWallet(mine, storage)).rejects.toThrow();
  });

  it("says the key is gone, not that there is nothing to export, when signing after storage was cleared (Q-29)", async () => {
    const storage = new MemoryStorage();
    const publicKey = await createDeviceWallet(PIN, storage);
    storage.clear();
    await expect(
      signTransactionWithDeviceWallet(publicKey, unsignedTx(publicKey).toXDR(), PIN, storage),
    ).rejects.toThrow("The key is no longer in this browser, so it can't sign. Restore your backup file to continue.");
  });

  it("asks a seller to back up a new key before locking, and stops once it is exported or restored", async () => {
    const browserA = new MemoryStorage();
    const publicKey = await createDeviceWallet(PIN, browserA);
    const wallet = { kind: "device", publicKey };
    // A fresh key exists only in this browser: locking now risks the reclaim.
    expect(lockBackupProblem(wallet, browserA)).toMatch(/Export a backup of your key first/);
    expect(lockBackupProblem({ kind: "freighter", publicKey }, browserA)).toBeNull();

    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(publicKey, browserA)));
    expect(lockBackupProblem(wallet, browserA)).toBeNull();
    // The marker is not a KM entry, so it never shows up as a second key.
    expect(await getDeviceWalletPublicKey(browserA)).toBe(publicKey);

    // A key restored from a file already has a backup: that file.
    const browserB = new MemoryStorage();
    await importDeviceWallet(backup, PIN, browserB);
    expect(lockBackupProblem(wallet, browserB)).toBeNull();

    const browserC = new MemoryStorage();
    await createDeviceWallet("other pincode", browserC);
    await replaceDeviceWallet(backup, PIN, browserC);
    expect(lockBackupProblem(wallet, browserC)).toBeNull();

    // A wrong pincode stores nothing, so it marks nothing either.
    const browserD = new MemoryStorage();
    await expect(importDeviceWallet(backup, "wrong pincode", browserD)).rejects.toBeInstanceOf(WrongPincodeError);
    expect(lockBackupProblem(wallet, browserD)).toMatch(/Export a backup/);
  });

  it("says the key is gone, not that the pincode is wrong, when signing in after another tab removed it", async () => {
    // One browser, two tabs: both share this storage.
    const storage = new MemoryStorage();
    const other = new MemoryStorage();
    const otherKey = await createDeviceWallet("other pincode", other);
    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(otherKey, other)));
    const mine = await createDeviceWallet(PIN, storage);
    // Tab 1 swaps the key; tab 2 still shows `mine` and signs in with it.
    await replaceDeviceWallet(backup, "other pincode", storage, mine);
    const signIn = signMessageWithDeviceWallet(mine, "hi", PIN, storage);
    await expect(signIn).rejects.not.toBeInstanceOf(WrongPincodeError);
    await expect(signIn).rejects.toThrow("The key is no longer in this browser");
  });

  it("refuses to replace a key other than the one the user was shown and confirmed losing", async () => {
    const storage = new MemoryStorage();
    const shown = await createDeviceWallet(PIN, storage);
    // Another tab cleared site data and made a fresh key, not yet backed up.
    storage.clear();
    const fresh = await createDeviceWallet(PIN, storage);

    const other = new MemoryStorage();
    const otherKey = await createDeviceWallet("other pincode", other);
    const backup = JSON.parse(JSON.stringify(await exportDeviceWallet(otherKey, other)));

    await expect(replaceDeviceWallet(backup, "other pincode", storage, shown)).rejects.toThrow(/another tab/);
    expect(await getDeviceWalletPublicKey(storage)).toBe(fresh);
    expect(await exportDeviceWallet(fresh, storage)).toBeTruthy();
    await expect(exportDeviceWallet(otherKey, storage)).rejects.toThrow();
  });
});
