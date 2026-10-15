'use client';

// Client-only: always import it through components/map/index.tsx (next/dynamic, ssr: false).

import "maplibre-gl/dist/maplibre-gl.css";

import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

import type { CityPin } from "./pins";

// OpenFreeMap's hosted styles (openfreemap.org/quick_start): no API key, no account.
const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/liberty";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

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
  const { resolvedTheme } = useTheme();
  const style = resolvedTheme === "dark" ? STYLE_DARK : STYLE_LIGHT;

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style,
      center: [20, 25],
      zoom: 1.4,
      attributionControl: {
        // OpenFreeMap / OpenMapTiles / OpenStreetMap credits come from the style's
        // own source attribution; the city centroids come from GeoNames.
        customAttribution: '<a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> (CC BY 4.0)',
      },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("click", () => onSelect.current(null));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // The style is swapped below; the map itself is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    map.current?.setStyle(style);
  }, [style]);

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
      btn.setAttribute("aria-label", `${pin.cityName}: ${pin.listings.length} listings`);
      btn.className = [
        "grid h-8 min-w-8 place-items-center rounded-full px-2 font-display text-sm font-bold shadow-lg ring-2 transition-transform hover:scale-110",
        pin.cityId === selectedCityId
          ? "scale-110 bg-pairy-ink text-pairy-cream ring-pairy-flame"
          : "bg-pairy-flame text-white ring-white",
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
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
