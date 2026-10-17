// Freighter through @creit.tech/stellar-wallets-kit v2, scoped to the
// Freighter module only and pinned to testnet. Loaded lazily: the kit touches
// `window` and is only ever needed in the browser.

import { Networks } from "@stellar/stellar-sdk";

let kitPromise: Promise<typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit> | null = null;

function kit() {
  kitPromise ??= (async () => {
    const [{ StellarWalletsKit }, { FreighterModule, FREIGHTER_ID }, { Networks: KitNetworks }] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/types"),
    ]);
    StellarWalletsKit.init({
      modules: [new FreighterModule()],
      selectedWalletId: FREIGHTER_ID,
      network: KitNetworks.TESTNET,
    });
    return StellarWalletsKit;
  })();
  return kitPromise;
}

/** The kit rejects with `{ code, message }` objects; surface them as Errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const message = (e as { message?: unknown })?.message;
    throw new Error(typeof message === "string" && message ? message : "Freighter request failed.");
  }
}

/** Shown when the extension is missing; the onboarding screen links freighter.app. */
export const FREIGHTER_MISSING =
  "Freighter isn't available in this browser. Install the extension from freighter.app, or make a key on this device instead.";

/** Asks Freighter for access and returns the account's public key. */
export async function connectFreighter(): Promise<string> {
  const k = await kit();
  // The kit's own message for this is "Freighter is not connected".
  if (!(await k.selectedModule.isAvailable())) throw new Error(FREIGHTER_MISSING);
  const { address } = await call(() => k.fetchAddress());
  const { networkPassphrase } = await call(() => k.getNetwork());
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error("Freighter is on another network. Switch it to Testnet and try again.");
  }
  return address;
}

function assertSigner(expected: string, signer: string | undefined) {
  if (signer && signer !== expected) {
    throw new Error("Freighter signed with a different account. Switch Freighter to the connected account.");
  }
}

export async function signTransactionWithFreighter(address: string, xdr: string): Promise<string> {
  const k = await kit();
  const { signedTxXdr, signerAddress } = await call(() =>
    k.signTransaction(xdr, { address, networkPassphrase: Networks.TESTNET }),
  );
  assertSigner(address, signerAddress);
  return signedTxXdr;
}

/**
 * Freighter signs SEP-53 (SHA-256 of "Stellar Signed Message:\n" + message)
 * for freighter-api >= 5, which the kit ships (6.0.0), and returns the 64-byte
 * signature as base64: exactly what Keypair.verifyMessage checks on the server.
 */
export async function signMessageWithFreighter(address: string, message: string): Promise<string> {
  const k = await kit();
  const { signedMessage, signerAddress } = await call(() =>
    k.signMessage(message, { address, networkPassphrase: Networks.TESTNET }),
  );
  assertSigner(address, signerAddress);
  return signedMessage;
}

export async function disconnectFreighter(): Promise<void> {
  if (kitPromise) await (await kitPromise).disconnect();
}
