// Whether this browser has handed out a backup of a device key: the key was
// exported, or it was restored from a backup file. Kept apart from
// device-wallet.ts so the lock screen can check it without loading the
// KeyManager bundle. Public data only; every storage access is guarded.

const key = (publicKey: string) => `pairy:backup:${publicKey}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function markBackedUp(publicKey: string, store = storage()) {
  try {
    store?.setItem(key(publicKey), "1");
  } catch {
    // Storage full or blocked: the lock screen asks for a backup again.
  }
}

export function isBackedUp(publicKey: string, store = storage()): boolean {
  try {
    return store?.getItem(key(publicKey)) === "1";
  } catch {
    return false;
  }
}

/**
 * Why a seller should not lock yet: a device key with no backup. Taking the
 * lock back needs this key after the window, and the browser can delete it
 * before then. null for Freighter or a key that has a backup.
 */
export function lockBackupProblem(wallet: { kind: string; publicKey: string } | null, store = storage()): string | null {
  if (wallet?.kind !== "device" || isBackedUp(wallet.publicKey, store)) return null;
  return "Export a backup of your key first. Taking the lock back later needs this key, and the browser can delete it: Safari does after 7 days of use without opening Pairy, a private window when it closes.";
}
