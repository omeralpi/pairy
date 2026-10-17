// Regenerates lib/geo/cities.json from GeoNames.
//
// Data: GeoNames cities15000 (https://www.geonames.org), licensed CC BY 4.0.
// Attribution is shown on the map and in the listing city picker.
//
//   curl -LO https://download.geonames.org/export/dump/cities15000.zip
//   curl -LO https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   unzip cities15000.zip
//   pnpm tsx lib/geo/build-cities.ts cities15000.txt admin1CodesASCII.txt
//
// Only cities with population >= 100,000 are kept, and coordinates are rounded
// to 2 decimals (~1 km): a listing is placed at a city, never at a person.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIN_POPULATION = 100_000;

const [input, admin1File] = process.argv.slice(2);
if (!input || !admin1File) {
  console.error("usage: tsx lib/geo/build-cities.ts <cities15000.txt> <admin1CodesASCII.txt>");
  process.exit(1);
}

// "US.MO" -> "Missouri": tells apart the three Springfields in the picker.
const admin1 = new Map(
  readFileSync(admin1File, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .map((f) => [f[0], f[1]] as const),
);

const round2 = (n: number) => Math.round(n * 100) / 100;
// GeoNames writes some compound names with an en dash ("North Ossetia\u2013Alania");
// names are copied into listings, so keep them to a plain hyphen.
const dehyphen = (s: string) => s.replace(/[\u2013\u2014]/g, "-");

const rows = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"))
  .map((f) => ({
    id: f[0],
    name: dehyphen(f[1]),
    ascii: f[2],
    cc: f[8],
    region: dehyphen(admin1.get(`${f[8]}.${f[10]}`) ?? ""),
    lat: round2(Number(f[4])),
    lng: round2(Number(f[5])),
    population: Number(f[14]),
  }))
  .filter((c) => c.population >= MIN_POPULATION)
  // Sorted by population so a prefix search surfaces the big city first.
  .sort((a, b) => b.population - a.population)
  .map(({ population: _population, ...c }) => c);

const out = path.join(__dirname, "cities.json");
writeFileSync(out, JSON.stringify(rows) + "\n");
console.log(`wrote ${rows.length} cities to ${out}`);
