import { describe, expect, it } from "vitest";

import { CITIES, cityById } from "@/lib/geo/cities";
import { createCallerFactory } from "@/server/api/trpc";

import { geoRouter } from "./geo";

const geo = createCallerFactory(geoRouter)({ db: null as never, session: null, resHeaders: new Headers() });

describe("geo.searchCities", () => {
  it("finds a city regardless of diacritics and case", async () => {
    for (const q of ["istanbul", "İstanbul", "ISTAN"]) {
      expect((await geo.searchCities({ q }))[0]).toMatchObject({ name: "Istanbul", countryCode: "TR" });
    }
  });

  it("caps results at 10 and never returns coordinates", async () => {
    const res = await geo.searchCities({ q: "san" });
    expect(res).toHaveLength(10);
    for (const c of res) expect(Object.keys(c).sort()).toEqual(["countryCode", "id", "name", "region"]);
  });

  it("returns nothing for an empty query", async () => {
    expect(await geo.searchCities({ q: "  " })).toEqual([]);
  });
});

describe("cities.json", () => {
  it("holds only coarse, 2-decimal coordinates", () => {
    expect(CITIES.length).toBeGreaterThan(5000);
    for (const c of CITIES) {
      expect(Math.round(c.lat * 100) / 100).toBe(c.lat);
      expect(Math.round(c.lng * 100) / 100).toBe(c.lng);
    }
  });

  it("has no en or em dash in a name or region (they are copied into listings)", () => {
    const dashed = CITIES.filter((c) => /[\u2013\u2014]/.test(c.name + c.ascii + c.region));
    expect(dashed.map((c) => c.id)).toEqual([]);
    expect(cityById("473249")?.region).toBe("North Ossetia-Alania");
  });
});
