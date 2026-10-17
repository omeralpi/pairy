'use client';

// Client-only: always import it through components/map/index.tsx (next/dynamic, ssr: false).

import "maplibre-gl/dist/maplibre-gl.css";

import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import { useEffect, useRef } from "react";

import type { CityPin } from "./pins";

// OpenFreeMap's hosted styles (openfreemap.org/quick_start): no API key, no account.
// Positron is near-monochrome, so the beacon pins are the only colour on the map.
const STYLE = "https://tiles.openfreemap.org/styles/positron";
const PAPER = "#F5F1EA";

// MapLibre locates its worker from import.meta.url, which the bundler rewrites,
// and its ESM worker cannot go through Next's production minifier. The
// predev/prebuild scripts copy it to public/ and we load it from there.
setWorkerUrl("/maplibre-gl-worker.mjs");

export function ListingsMap({
  pins,
  selectedCityId,
  onSelectCity,
}: {
  pins: CityPin[];
  selectedCityId: string | null;
  onSelectCity: (cityId: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const onSelect = useRef(onSelectCity);
  onSelect.current = onSelectCity;

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: STYLE,
      center: [20, 25],
      zoom: 1.4,
      attributionControl: {
        // Keep the credits written out, not collapsed behind an (i) button.
        compact: false,
        // OpenFreeMap / OpenMapTiles / OpenStreetMap credits come from the style's
        // own source attribution; the city centroids come from GeoNames.
        customAttribution: '<a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> (CC BY 4.0)',
      },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("click", () => onSelect.current(null));
    // Warm the style's land colour to paper so the map sits on the page, not on white.
    m.on("style.load", () => {
      if (m.getLayer("background")) m.setPaintProperty("background", "background-color", PAPER);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const mk of markers.current) mk.remove();
    markers.current = pins.map((pin) => {
      // MapLibre positions the marker element with an inline transform, so the
      // hover/selected scale lives on an inner button.
      const el = document.createElement("div");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", `${pin.cityName}: ${pin.listings.length} ${pin.listings.length === 1 ? "listing" : "listings"}`);
      btn.className = [
        // Beacon belongs here and only here: it means a peer is near.
        "grid h-8 min-w-8 place-items-center rounded-full bg-beacon-700 px-2 font-mono text-xs font-medium text-white shadow-sm ring-[3px] transition-transform hover:scale-110",
        pin.cityId === selectedCityId ? "scale-110 ring-ink" : "ring-paper",
      ].join(" ");
      btn.textContent = String(pin.listings.length);
      el.appendChild(btn);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect.current(pin.cityId);
      });
      return new Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(m);
    });
    if (!fitted.current && pins.length > 0) {
      fitted.current = true;
      const bounds = new LngLatBounds();
      for (const p of pins) bounds.extend([p.lng, p.lat]);
      m.fitBounds(bounds, { padding: 80, maxZoom: 6, duration: 0 });
    }
  }, [pins, selectedCityId]);

  // maplibre-gl.css forces position: relative on the map container, so it fills a positioned wrapper.
  return (
    <div className="absolute inset-0 bg-paper [&_.maplibregl-ctrl-attrib]:bg-paper/85 [&_.maplibregl-ctrl-attrib]:text-[10px] [&_.maplibregl-ctrl-attrib]:text-slate">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
