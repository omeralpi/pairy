import type { Listing } from "@/components/listing/format";

export type CityPin = {
  cityId: string;
  cityName: string;
  countryCode: string;
  lat: number;
  lng: number;
  listings: Listing[];
};

/** One pin per city, however many listings it holds. */
export function groupByCity(listings: Listing[]): CityPin[] {
  const pins = new Map<string, CityPin>();
  for (const l of listings) {
    const pin = pins.get(l.cityId);
    if (pin) pin.listings.push(l);
    else
      pins.set(l.cityId, {
        cityId: l.cityId,
        cityName: l.cityName,
        countryCode: l.countryCode,
        lat: l.latitude,
        lng: l.longitude,
        listings: [l],
      });
  }
  return [...pins.values()];
}
