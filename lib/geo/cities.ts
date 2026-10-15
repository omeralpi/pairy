// Server-side city table. Listings are placed at a city centroid from this
// file, never at a coordinate supplied by the client.

import rows from "./cities.json";

export type City = {
  id: string;
  name: string;
  ascii: string;
  cc: string;
  region: string;
  lat: number;
  lng: number;
};

export const CITIES: readonly City[] = rows;

const byId = new Map(CITIES.map((c) => [c.id, c]));

export function cityById(id: string): City | undefined {
  return byId.get(id);
}

/** Lowercase and strip diacritics, so "istanbul" finds "İstanbul" and "kadikoy" finds "Kadıköy". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i").toLowerCase();
}

const folded = CITIES.map((c) => ({ city: c, keys: [fold(c.name), fold(c.ascii)] }));

/** Prefix matches first, then substring matches; each group keeps the population order of the file. */
export function searchCities(q: string, limit = 10): City[] {
  const needle = fold(q.trim());
  if (!needle) return [];
  const prefix: City[] = [];
  const inner: City[] = [];
  for (const { city, keys } of folded) {
    if (keys.some((k) => k.startsWith(needle))) prefix.push(city);
    else if (needle.length >= 3 && keys.some((k) => k.includes(needle))) inner.push(city);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...inner].slice(0, limit);
}
