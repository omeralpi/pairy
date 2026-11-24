'use client';

import dynamic from "next/dynamic";
import { Component, useContext, type ErrorInfo, type ReactNode } from "react";

import { PrivyAdapterContext } from "@/lib/wallet/privy-adapter";

// O-14: Privy's JS (about 1.35 MB raw) is fetched after the page has painted,
// in the browser only, and not at all without an App ID. The dynamic import
// lives here, not in privy-layer.tsx, which the no-privy-signers check keeps
// to static imports.
const PrivyLayer = dynamic(() => import("@/components/providers/privy-layer").then((m) => m.PrivyLayer), { ssr: false });

/**
 * A chunk that fails to load, or Privy throwing while it mounts, must not take
 * the (app) pages down for device-key and Freighter users: the boundary
 * renders nothing and tells WalletProvider that Privy failed.
 */
export class PrivyBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(_error: Error) {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error(error);
    this.props.onFail();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function PrivyLayerDynamic() {
  const { setFailed } = useContext(PrivyAdapterContext);
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return null;
  return (
    <PrivyBoundary onFail={setFailed}>
      <PrivyLayer />
    </PrivyBoundary>
  );
}
