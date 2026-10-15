// The cash currencies a listing can quote. A short fixed list keeps the
// filter chips usable; extend it when someone actually needs another one.
export const FIAT_CODES = [
  "USD",
  "EUR",
  "GBP",
  "TRY",
  "NGN",
  "KES",
  "ARS",
  "BRL",
  "MXN",
  "INR",
  "PHP",
  "UAH",
] as const;

export type FiatCode = (typeof FIAT_CODES)[number];
