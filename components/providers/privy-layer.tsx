'use client';

import { PrivyProvider, useLogin, useLogout, usePrivy, useSigners } from "@privy-io/react-auth";
import { useCreateWallet, useExportWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { useContext, useEffect, useMemo, useRef } from "react";

import { PRIVY_LOGIN_CLOSED, PrivyAdapterContext, type PrivyAdapter } from "@/lib/wallet/privy-adapter";
import { findStellarWallet, hexSignatureToBytes } from "@/lib/wallet/privy-sign";

/**
 * The only file that imports Privy (D1 §1.2; no-privy-signers holds the
 * boundary). Mounted under app/(app) only (DECISIONS 4), loaded after the page
 * (O-14), and rendering nothing: it builds a PrivyAdapter from Privy's hooks and
 * hands it to WalletProvider through PrivyAdapterContext. Email and Google are
 * the only login methods (DECISIONS 0.3); no Ethereum or Solana wallet is ever
 * created (O-5): the Stellar wallet is made explicitly with createWallet.
 * Without an App ID nothing is mounted.
 */
export function PrivyLayer() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return null;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google"],
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
      }}
    >
      <AdapterBridge />
    </PrivyProvider>
  );
}

type PrivyUser = NonNullable<ReturnType<typeof usePrivy>["user"]>;

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** "a…@example.com" for an email login, "Google" for Google. Local only. */
function loginLabelOf(user: PrivyUser | null): string | null {
  if (user?.email) {
    const at = user.email.address.indexOf("@");
    return at > 0 ? `${user.email.address[0]}…${user.email.address.slice(at)}` : "email";
  }
  return user?.google ? "Google" : null;
}

function AdapterBridge() {
  const { ready, authenticated, user } = usePrivy();
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const { exportWallet } = useExportWallet();
  const { setAdapter } = useContext(PrivyAdapterContext);

  // One login at a time: resolved by onComplete, rejected by onError, which
  // also fires when the user closes the modal.
  const pending = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const { login } = useLogin({
    onComplete: ({ user: loggedIn }) => {
      live.current.user = loggedIn;
      live.current.authenticated = true;
      pending.current?.resolve();
      pending.current = null;
    },
    onError: (code) => {
      pending.current?.reject(new Error(code === "exited_auth_flow" ? PRIVY_LOGIN_CLOSED : `Privy login failed (${code}).`));
      pending.current = null;
    },
  });

  // The adapter's methods read the latest hook values from here, so the adapter
  // object itself changes only when a value WalletProvider renders changes.
  const live = useRef({ user, authenticated, login, logout, createWallet, signRawHash, exportWallet });
  live.current = { user, authenticated, login, logout, createWallet, signRawHash, exportWallet };

  const loginLabel = loginLabelOf(user);
  const adapter = useMemo<PrivyAdapter>(
    () => ({
      ready,
      authenticated,
      loginLabel,
      login: () => {
        if (live.current.authenticated) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          if (pending.current) return reject(new Error("Another login is already open."));
          pending.current = { resolve, reject };
          live.current.login();
        });
      },
      logout: async () => {
        await live.current.logout();
        // Known here before the next render, as onComplete does for a login,
        // so a login asked for right after this one opens Privy's modal.
        live.current.user = null;
        live.current.authenticated = false;
      },
      stellarAddress: () => findStellarWallet(live.current.user?.linkedAccounts)?.address ?? null,
      createStellarWallet: async () => {
        // The returned wallet is the API shape (snake_case); only its address is needed here.
        const { wallet } = await live.current.createWallet({ chainType: "stellar" });
        return wallet.address;
      },
      signRawHash: async (address, hash32) => {
        const { signature } = await live.current.signRawHash({ address, chainType: "stellar", hash: `0x${bytesToHex(hash32)}` });
        return hexSignatureToBytes(signature);
      },
      exportKey: (address) => live.current.exportWallet({ address }),
    }),
    [ready, authenticated, loginLabel],
  );

  useEffect(() => {
    setAdapter(adapter);
  }, [adapter, setAdapter]);
  useEffect(() => () => setAdapter(null), [setAdapter]);

  return null;
}
