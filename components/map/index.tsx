'use client';

import dynamic from "next/dynamic";

// MapLibre touches window and WebGL at import time, so it never renders on the server.
export const ListingsMap = dynamic(() => import("./listings-map").then((m) => m.ListingsMap), {
  ssr: false,
  loading: () => <div className="absolute inset-0 animate-pulse bg-muted" />,
});

export { groupByCity, type CityPin } from "./pins";
