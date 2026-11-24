'use client';

import dynamic from "next/dynamic";

// O-14: Privy's JS (about 1.35 MB raw) is fetched after the page has painted,
// in the browser only, and not at all without an App ID. The dynamic import
// lives here, not in privy-layer.tsx, which the no-privy-signers check keeps
// to static imports.
const PrivyLayer = dynamic(() => import("@/components/providers/privy-layer").then((m) => m.PrivyLayer), { ssr: false });

export function PrivyLayerDynamic() {
  return process.env.NEXT_PUBLIC_PRIVY_APP_ID ? <PrivyLayer /> : null;
}
