// The device wallet (SOW D2). The keypair is made here by Keypair.random(),
// whose entropy comes from WebCrypto (`crypto.getRandomValues`, via
// @noble/ed25519 inside stellar-sdk 17), and is handed straight to SDF's
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
    password: pincode,
    encrypterName: ScryptEncrypter.name,
  });
  return publicKey;
}

async function unlock(publicKey: string, pincode: string, storage: Storage) {
  try {
    return await keyManager(storage).loadKey(publicKey, pincode);
  } catch {
    throw new WrongPincodeError();
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
  await exportDeviceWallet(publicKey, storage); // so a missing key isn't reported as a wrong pincode
  let signed: { toXDR(): string };
  try {
    // KM decrypts, signs and drops the key; shouldCache is off by default.
    signed = await keyManager(storage).signTransaction({
      // KM bundles its own stellar-sdk copy; the handler only calls
      // getKeypairSignature/addSignature, which our Transaction provides.
      transaction: transaction as never,
      id: publicKey,
      password: pincode,
    });
  } catch {
    throw new WrongPincodeError();
  }
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
  const key = await unlock(publicKey, pincode, storage);
  const signature = Keypair.fromSecret(key.privateKey).signMessage(message);
  return btoa(String.fromCharCode(...signature));
}

/** The KM keystore entry exactly as stored: pincode-encrypted, never the raw secret. */
export async function exportDeviceWallet(publicKey: string, storage: Storage = localStorage): Promise<EncryptedKey> {
  const entry = await keyStore(storage).loadKey(publicKey).catch(() => undefined);
  if (!entry) throw new Error("No wallet on this device to export.");
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
  return backup.id;
}
