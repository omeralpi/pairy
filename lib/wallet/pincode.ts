// Pincode rules for the device wallet. Kept apart from device-wallet.ts so the
// UI can check them without loading the KeyManager bundle.

export const PINCODE_MIN_LENGTH = 6;

/** null when the pincode is acceptable, otherwise why it is not. */
export function pincodeProblem(pincode: string): string | null {
  if (pincode.length < PINCODE_MIN_LENGTH) {
    return `Use at least ${PINCODE_MIN_LENGTH} characters.`;
  }
  return null;
}

/** All-digit pincodes are allowed but far easier to brute-force offline. */
export function pincodeIsWeak(pincode: string): boolean {
  return /^\d+$/.test(pincode);
}
