// The device wallet (SOW D2). The keypair is made here by Keypair.random(),
// whose entropy comes from WebCrypto (`crypto.getRandomValues`, via
// @noble/curves inside stellar-sdk 17), and is handed straight to SDF's
// KeyManager, which encrypts it under the user's pincode with ScryptEncrypter
// and writes only the ciphertext to localStorage. We write no KDF or
// encryption code. Nothing in this module talks to the Pairy server.

import {
  KeyManager,
  KeyType,
  LocalStorageKeyStore,
  ScryptEncrypter,
  type EncryptedKey,
} from "@stellar/typescript-wallet-sdk-km";
import { Keypair, Networks, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { markBackedUp } from "./backup";
import { pincodeProblem } from "./pincode";

const STORAGE_PREFIX = "pairy-keys";

/** Thrown when the pincode does not decrypt the stored key. */
export class WrongPincodeError extends Error {
  constructor() {
    super("That pincode doesn't unlock this wallet.");
  }
}

function keyStore(storage: Storage) {
  const store = new LocalStorageKeyStore();
  // configure() only assigns fields and never rejects for a real Storage.
  void store.configure({ storage, prefix: STORAGE_PREFIX });
  return store;
}

function keyManager(storage: Storage) {
  const km = new KeyManager({ keyStore: keyStore(storage), defaultNetworkPassphrase: Networks.TESTNET });
  km.registerEncrypter(ScryptEncrypter);
  return km;
}

/** The public key of the wallet stored on this device, or null. */
export async function getDeviceWalletPublicKey(storage: Storage = localStorage): Promise<string | null> {
  const ids = await keyManager(storage).loadAllKeyIds();
  return ids.find((id) => StrKey.isValidEd25519PublicKey(id)) ?? null;
}

async function assertNoWallet(storage: Storage) {
  if (await getDeviceWalletPublicKey(storage)) {
    throw new Error("This browser already holds a Pairy wallet.");
  }
}

/** Generates a keypair on this device and stores it encrypted. Returns the public key. */
export async function createDeviceWallet(pincode: string, storage: Storage = localStorage): Promise<string> {
  const problem = pincodeProblem(pincode);
  if (problem) throw new Error(problem);
  await assertNoWallet(storage);

  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  await keyManager(storage).storeKey({
    // The public key is the KM id, so an exported entry names its own account.
    key: {
      id: publicKey,
      publicKey,
      privateKey: keypair.secret(),
      type: KeyType.plaintextKey,
      network: Networks.TESTNET,
    },
    password: pincode.normalize("NFC"),
    encrypterName: ScryptEncrypter.name,
  });
  return publicKey;
}

/**
 * Runs `use` with the pincode in NFC, the form createDeviceWallet stores, so an
 * accented pincode typed or pasted with decomposed accents still matches. Then
 * as typed and in NFD, for a wallet stored before pincodes were normalized.
 */
async function withPincode<T>(pincode: string, use: (password: string) => Promise<T>): Promise<T> {
  for (const password of new Set([pincode.normalize("NFC"), pincode, pincode.normalize("NFD")])) {
    try {
      return await use(password);
    } catch {
      // Wrong for this form; try the next.
    }
  }
  throw new WrongPincodeError();
}

function unlock(publicKey: string, pincode: string, storage: Storage) {
  return withPincode(pincode, (password) => keyManager(storage).loadKey(publicKey, password));
}

/** So a missing key (storage cleared, or replaced in another tab) isn't reported as a wrong pincode. */
async function assertKeyStored(publicKey: string, storage: Storage) {
  if (!(await keyStore(storage).loadKey(publicKey).catch(() => undefined))) {
    throw new Error("The key is no longer in this browser, so it can't sign. Restore your backup file to continue.");
  }
}

/** Signs a testnet transaction XDR with the device key; returns the signed XDR. */
export async function signTransactionWithDeviceWallet(
  publicKey: string,
  xdr: string,
  pincode: string,
  storage: Storage = localStorage,
): Promise<string> {
  const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  await assertKeyStored(publicKey, storage);
  // KM decrypts, signs and drops the key; shouldCache is off by default.
  const signed: { toXDR(): string } = await withPincode(pincode, (password) =>
    keyManager(storage).signTransaction({
      // KM bundles its own stellar-sdk copy; the handler only calls
      // getKeypairSignature/addSignature, which our Transaction provides.
      transaction: transaction as never,
      id: publicKey,
      password,
    }),
  );
  return signed.toXDR();
}

/**
 * SEP-53 signs `message` (used only for login). KM has no message-signing
 * API, so the key is decrypted through KM for this call alone. Returns the
 * signature as base64.
 */
export async function signMessageWithDeviceWallet(
  publicKey: string,
  message: string,
  pincode: string,
  storage: Storage = localStorage,
): Promise<string> {
  await assertKeyStored(publicKey, storage);
  const key = await unlock(publicKey, pincode, storage);
  const signature = Keypair.fromSecret(key.privateKey).signMessage(message);
  return btoa(String.fromCharCode(...signature));
}

/** The KM keystore entry exactly as stored: pincode-encrypted, never the raw secret. */
export async function exportDeviceWallet(publicKey: string, storage: Storage = localStorage): Promise<EncryptedKey> {
  const entry = await keyStore(storage).loadKey(publicKey).catch(() => undefined);
  if (!entry) throw new Error("No wallet on this device to export.");
  markBackedUp(publicKey, storage);
  return entry;
}

function isEncryptedKey(value: unknown): value is EncryptedKey {
  const v = value as Partial<Record<keyof EncryptedKey, unknown>> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    StrKey.isValidEd25519PublicKey(v.id) &&
    v.encrypterName === ScryptEncrypter.name &&
    typeof v.encryptedBlob === "string" &&
    typeof v.salt === "string"
  );
}

/**
 * Stores an exported entry on this device. The pincode must decrypt it to the
 * key its id names, otherwise nothing is kept. Returns the public key.
 */
export async function importDeviceWallet(
  backup: unknown,
  pincode: string,
  storage: Storage = localStorage,
): Promise<string> {
  if (!isEncryptedKey(backup)) throw new Error("That file isn't a Pairy wallet backup.");
  await assertNoWallet(storage);
  return storeVerified(backup, pincode, storage);
}

/** Stores `backup` only if `pincode` decrypts it to the key its id names. */
async function storeVerified(backup: EncryptedKey, pincode: string, storage: Storage): Promise<string> {
  const store = keyStore(storage);
  await store.storeKeys([backup]);
  try {
    const key = await unlock(backup.id, pincode, storage);
    if (Keypair.fromSecret(key.privateKey).publicKey() !== backup.id) {
      throw new Error("This backup is corrupted: its key doesn't match its address.");
    }
  } catch (e) {
    await store.removeKey(backup.id);
    throw e;
  }
  // Restored from a file, so that file is its backup.
  markBackedUp(backup.id, storage);
  return backup.id;
}

/**
 * Swaps the key in this browser for the one in `backup`. The new key is
 * stored and checked against its pincode first; the old one is removed only
 * after that works, so a wrong pincode or a bad file leaves it untouched.
 * `shown` is the key the user was told would be removed; if another tab has
 * changed the stored key since, nothing is replaced.
 */
export async function replaceDeviceWallet(
  backup: unknown,
  pincode: string,
  storage: Storage = localStorage,
  shown?: string,
): Promise<string> {
  if (!isEncryptedKey(backup)) throw new Error("That file isn't a Pairy wallet backup.");
  const current = await getDeviceWalletPublicKey(storage);
  if (shown !== undefined && current !== shown) {
    throw new Error("The key in this browser was changed in another tab, so nothing was replaced. Reload this page and check which key you are replacing.");
  }
  if (current === backup.id) throw new Error("That backup is the key already in this browser.");
  const publicKey = await storeVerified(backup, pincode, storage);
  if (current) await keyStore(storage).removeKey(current);
  return publicKey;
}
