'use client';

import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { shortAddress } from "@/components/listing/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeNextPath } from "@/lib/auth/next-path";
import { useLogin } from "@/lib/auth/use-login";
import { useSession } from "@/lib/auth/use-session";
import { PINCODE_MIN_LENGTH, pincodeIsWeak, pincodeProblem } from "@/lib/wallet/pincode";
import { useWalletContext, type Wallet } from "@/lib/wallet/use-wallet";

type Mode = "choose" | "create" | "import" | "replace";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export default function OnboardPage() {
  const router = useRouter();
  const walletCtx = useWalletContext();
  const { wallet, ready, deviceWalletPublicKey } = walletCtx;
  const { publicKey: sessionKey } = useSession();
  const { login } = useLogin();
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Back to the page that sent the user here (e.g. a trade link), if any.
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    setNext(safeNextPath(new URLSearchParams(window.location.search).get("next"), window.location.origin));
  }, []);

  /** Runs a wallet step, then signs in with the resulting wallet. */
  const run = async (step: () => Promise<Wallet> | Wallet, after = next ?? "/wallet", pincode?: string) => {
    setBusy(true);
    setError(null);
    try {
      const w = await step();
      // The wallet step is done; if login fails, "Sign in again" retries it.
      setMode("choose");
      await login(w, pincode);
      router.push(after);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <Shell><p className="text-sm text-slate">Loading your wallet…</p></Shell>;

  if (wallet && sessionKey === wallet.publicKey) {
    return (
      <Shell>
        <section className="space-y-4 border-t border-line pt-8">
          <h2 className="text-xl font-semibold tracking-tight">You&apos;re signed in.</h2>
          <p className="text-sm text-slate">
            {wallet.kind === "freighter" ? "Freighter" : "Key on this device"} ·{" "}
            <span className="font-mono text-ink">{shortAddress(wallet.publicKey)}</span>
          </p>
          <Button asChild className="w-full">
            <Link href={next ?? "/wallet"}>{next ? "Continue" : "Go to your wallet"}</Link>
          </Button>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      {error && (
        <ErrorNote title="That didn't work.">
          {error}
          {error.includes("freighter.app") && (
            <>
              {" "}
              <a
                href="https://freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
              >
                Get Freighter ↗
              </a>
            </>
          )}
        </ErrorNote>
      )}

      {wallet && !busy && (
        <section className="space-y-4 rounded-xl bg-sand p-5">
          <div className="space-y-1">
            <h2 className="font-semibold">Sign in again</h2>
            <p className="text-sm text-slate">
              Your {wallet.kind === "freighter" ? "Freighter account" : "key on this device"}{" "}
              <span className="font-mono text-ink">{shortAddress(wallet.publicKey)}</span> is connected but not signed in.
            </p>
          </div>
          <Button className="w-full" disabled={busy} onClick={() => run(() => wallet)}>
            Sign in
          </Button>
        </section>
      )}

      {mode === "choose" && (
        <div className="space-y-8">
          <ul className="divide-y divide-line border-y border-line">
            {deviceWalletPublicKey ? (
              <Choice
                note="Already on this phone"
                title="Use the key on this device"
                description={
                  <>
                    <span className="font-mono text-ink">{shortAddress(deviceWalletPublicKey)}</span>. Unlock it with your
                    pincode.
                  </>
                }
                disabled={busy}
                onClick={() => run(walletCtx.selectDeviceWallet)}
              />
            ) : (
              <Choice
                note="New here? Start here"
                title="Make a key on this device"
                description="Your browser makes the key and keeps it here, locked with a pincode you choose."
                disabled={busy}
                onClick={() => setMode("create")}
              />
            )}
            <Choice
              title="Use Freighter"
              description="For people who already have the Freighter extension. Switch it to Testnet first."
              disabled={busy}
              onClick={() => run(walletCtx.connectFreighter)}
            />
            {deviceWalletPublicKey ? (
              <Choice
                title="Use a different key on this device"
                description="Restore another backup file in place of the key stored here."
                disabled={busy}
                onClick={() => setMode("replace")}
              />
            ) : (
              <Choice
                title="Restore from a backup file"
                description="Bring back a key you exported from Pairy in another browser."
                disabled={busy}
                onClick={() => setMode("import")}
              />
            )}
          </ul>
          <p className="font-mono text-xs text-slate">Pairy never sees your key or your pincode.</p>
        </div>
      )}

      {mode === "create" && (
        <CreateForm
          busy={busy}
          onBack={() => setMode("choose")}
          onSubmit={(pincode) => run(() => walletCtx.createDeviceWallet(pincode), "/wallet?new=1", pincode)}
        />
      )}

      {mode === "import" && (
        <ImportForm
          busy={busy}
          onBack={() => setMode("choose")}
          onSubmit={(backup, pincode) => run(() => walletCtx.importDeviceWallet(backup, pincode), undefined, pincode)}
          onError={setError}
        />
      )}

      {mode === "replace" && deviceWalletPublicKey && (
        <ImportForm
          busy={busy}
          replacing={{
            current: deviceWalletPublicKey,
            onExport: () => walletCtx.exportBackup().catch((e) => setError(message(e))),
          }}
          onBack={() => setMode("choose")}
          onSubmit={(backup, pincode) => run(() => walletCtx.replaceDeviceWallet(backup, pincode), undefined, pincode)}
          onError={setError}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-10 px-4 py-10 md:py-16">
      <header className="space-y-4">
        <p className="eyebrow">Get started · testnet</p>
        <h1 className="text-4xl font-bold leading-[1.05] tracking-tight">
          Your key stays <em className="font-serif font-normal italic">on this phone.</em>
        </h1>
        <p className="text-slate">Pick how you&apos;ll sign. Then you sign one message to log in.</p>
      </header>
      {children}
    </div>
  );
}

function ErrorNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="alert" className="space-y-1 border-l-2 border-danger pl-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="text-sm text-ink [overflow-wrap:anywhere]">{children}</p>
    </div>
  );
}

function Choice({
  note,
  title,
  description,
  disabled,
  onClick,
}: {
  note?: string;
  title: string;
  description: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="group flex w-full items-center gap-4 py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink disabled:opacity-50"
      >
        <span className="flex-1 space-y-1">
          {note && <span className="eyebrow block">{note}</span>}
          <span className="block font-semibold text-ink">{title}</span>
          <span className="block text-sm text-slate">{description}</span>
        </span>
        <ArrowRight
          strokeWidth={1.5}
          className="size-4 shrink-0 text-slate transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
        />
      </button>
    </li>
  );
}

function StepHeader({ title, description, onBack, busy }: { title: string; description: string; onBack: () => void; busy: boolean }) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="inline-flex items-center gap-1.5 text-sm text-slate hover:text-ink disabled:opacity-50"
      >
        <ArrowLeft strokeWidth={1.5} className="size-4" />
        Back
      </button>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-slate">{description}</p>
    </div>
  );
}

function CreateForm({
  busy,
  onBack,
  onSubmit,
}: {
  busy: boolean;
  onBack: () => void;
  onSubmit: (pincode: string) => void;
}) {
  const [pincode, setPincode] = useState("");
  const [confirm, setConfirm] = useState("");
  const tooShort = pincodeProblem(pincode) !== null;
  const mismatch = confirm.length > 0 && confirm !== pincode;
  const allDigits = pincodeIsWeak(pincode);

  return (
    <section className="space-y-8 border-t border-line pt-8">
      <StepHeader
        title="Make a key on this device."
        description="Choose a pincode. You'll enter it each time you sign."
        onBack={onBack}
        busy={busy}
      />

      <div className="space-y-3 rounded-xl bg-sand p-5 text-sm">
        <p className="eyebrow">Read this first</p>
        <p className="font-semibold text-ink">There is no copy on any server.</p>
        <p className="text-ink">
          Your browser makes the key and keeps it only here, locked with your pincode. Pairy can&apos;t see it and
          can&apos;t get it back for you.
        </p>
        <p className="text-ink">
          If you lose this device, clear this browser&apos;s data, or forget the pincode, this testnet wallet is gone.
          Safari also deletes it after 7 days of use without opening Pairy, and a private window deletes it when it
          closes. Export a backup from the Wallet page right after you make it.
        </p>
        <p className="text-ink">The pincode is never sent anywhere. It is not a password to Pairy.</p>
      </div>

      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooShort && confirm === pincode) onSubmit(pincode);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="pincode">Pincode</Label>
          <Input
            id="pincode"
            type="password"
            autoComplete="new-password"
            className="font-mono"
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
          />
          <p className="text-xs text-slate">At least {PINCODE_MIN_LENGTH} characters.</p>
          {allDigits && (
            <p className="border-l-2 border-warning pl-3 text-xs text-ink">
              Digits only is weak: anyone who gets this browser&apos;s data could guess it. Add letters or make it
              longer.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm pincode</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className="font-mono"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="text-xs text-danger">The pincodes don&apos;t match.</p>}
        </div>
        <Button type="submit" className="w-full" disabled={busy || tooShort || confirm !== pincode}>
          {busy ? "Making your key…" : "Make my key and sign in"}
        </Button>
      </form>
    </section>
  );
}

function ImportForm({
  busy,
  replacing,
  onBack,
  onSubmit,
  onError,
}: {
  busy: boolean;
  /** Set when a key is already stored here and this restore replaces it. */
  replacing?: { current: string; onExport: () => void };
  onBack: () => void;
  onSubmit: (backup: unknown, pincode: string) => void;
  onError: (message: string | null) => void;
}) {
  const [backup, setBackup] = useState<unknown>(null);
  const [pincode, setPincode] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  return (
    <section className="space-y-8 border-t border-line pt-8">
      <StepHeader
        title={replacing ? "Use a different key on this device." : "Restore from a backup file."}
        description="Choose the .json file you exported, and enter the pincode it was made with."
        onBack={onBack}
        busy={busy}
      />
      {replacing && (
        <div className="space-y-3 rounded-xl bg-sand p-5 text-sm">
          <p className="eyebrow">Read this first</p>
          <p className="font-semibold text-ink">
            This removes <span className="font-mono">{shortAddress(replacing.current)}</span> from this browser.
          </p>
          <p className="text-ink">
            Pairy keeps no copy. Without a backup file of it, that wallet and anything in it are gone for good. Its
            key is removed only after the new backup unlocks.
          </p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={replacing.onExport}>
            Export a backup of {shortAddress(replacing.current)}
          </Button>
        </div>
      )}
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (backup && (!replacing || confirmed)) onSubmit(backup, pincode);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="backup">Backup file</Label>
          <Input
            id="backup"
            type="file"
            accept="application/json,.json"
            className="pt-4 text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setBackup(null);
              onError(null);
              if (!file) return;
              try {
                setBackup(JSON.parse(await file.text()));
              } catch {
                onError("That file isn't a Pairy wallet backup.");
              }
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="import-pincode">Pincode</Label>
          <Input
            id="import-pincode"
            type="password"
            autoComplete="off"
            className="font-mono"
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
          />
        </div>
        {replacing && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm leading-relaxed">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-ink"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I have a backup of <span className="font-mono">{shortAddress(replacing.current)}</span>, or I don&apos;t
              need that wallet any more.
            </span>
          </label>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !backup || pincode.length === 0 || (!!replacing && !confirmed)}
        >
          {busy ? "Restoring…" : replacing ? "Replace the key and sign in" : "Restore and sign in"}
        </Button>
      </form>
    </section>
  );
}
