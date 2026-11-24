// Signing with a raw ed25519 signer such as Privy's signRawHash, which sees
// only a 32-byte hash. Pairy hashes the transaction or the SEP-53 message
// itself, turns the hex signature back into bytes, and lets the SDK verify it
// against the hash before anything is sent. Pure functions; nothing from
// Privy is imported here.

import { FeeBumpTransaction, Networks, TransactionBuilder, hash, type Transaction } from "@stellar/stellar-sdk";

/** Signs exactly the 32 bytes it is given and returns the 64 signature bytes. */
export type RawSigner = (hash32: Uint8Array) => Promise<Uint8Array>;

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesToBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

function parseTestnetTransaction(xdr: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  if (tx instanceof FeeBumpTransaction) throw new Error("Fee bump transactions are not signed this way.");
  return tx;
}

/** "0x" + hex of the transaction's testnet hash: the input Privy signs. */
export function txHashHex(xdr: string): `0x${string}` {
  return `0x${bytesToHex(parseTestnetTransaction(xdr).hash())}`;
}

/** sha256("Stellar Signed Message:\n" ‖ utf8(message)): the SEP-53 digest Keypair.verifyMessage checks. */
export function sep53Hash(message: string): Uint8Array {
  const prefix = new TextEncoder().encode("Stellar Signed Message:\n");
  const body = new TextEncoder().encode(message);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return hash(joined);
}

/** "0x" + 128 hex characters → the 64 signature bytes; anything else throws. */
export function hexSignatureToBytes(signature: string): Uint8Array {
  const m = /^0x([0-9a-fA-F]{128})$/.exec(signature);
  if (!m) throw new Error(`Privy returned a signature of ${signature.length} characters, not 0x + 128 hex.`);
  return Uint8Array.from(m[1].match(/.{2}/g)!, (h) => parseInt(h, 16));
}

/**
 * Signs a testnet transaction with `rawSign` and returns the signed XDR.
 * addSignature verifies the signature against the hash and throws
 * "Invalid signature" if the signer signed anything else.
 */
export async function signXdrWithRawSigner(xdr: string, address: string, rawSign: RawSigner): Promise<string> {
  const tx = parseTestnetTransaction(xdr);
  tx.addSignature(address, bytesToBase64(await rawSign(tx.hash())));
  return tx.toXDR();
}

/** The base64 SEP-53 signature of `message`: what the unchanged auth.verify checks. */
export async function signMessageWithRawSigner(message: string, rawSign: RawSigner): Promise<string> {
  return bytesToBase64(await rawSign(sep53Hash(message)));
}

type LinkedWallet = { address: string; firstVerifiedAt?: unknown };

const isStellarWallet = (a: unknown): a is LinkedWallet =>
  typeof a === "object" &&
  a !== null &&
  (a as Record<string, unknown>).type === "wallet" &&
  (a as Record<string, unknown>).chainType === "stellar" &&
  typeof (a as Record<string, unknown>).address === "string";

/** When the wallet was first seen; undated wallets sort last. */
function verifiedAt({ firstVerifiedAt }: LinkedWallet): number {
  const ms = firstVerifiedAt instanceof Date ? firstVerifiedAt.getTime() : typeof firstVerifiedAt === "string" ? Date.parse(firstVerifiedAt) : NaN;
  return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * The user's Stellar wallet among Privy's `user.linkedAccounts` (the oldest
 * if there are several), or null. Field names from the S-01 types (WP-06).
 */
export function findStellarWallet(linkedAccounts: unknown): { address: string } | null {
  if (!Array.isArray(linkedAccounts)) return null;
  const [oldest] = linkedAccounts.filter(isStellarWallet).sort((a, b) => verifiedAt(a) - verifiedAt(b));
  return oldest ? { address: oldest.address } : null;
}
