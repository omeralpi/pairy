'use client';

import { KeyRound, Puzzle, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { shortAddress } from "@/components/listing/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/lib/auth/use-login";
import { useSession } from "@/lib/auth/use-session";
import { PINCODE_MIN_LENGTH, pincodeIsWeak, pincodeProblem } from "@/lib/wallet/pincode";
import { useWalletContext, type Wallet } from "@/lib/wallet/use-wallet";

type Mode = "choose" | "create" | "import";

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

  /** Runs a wallet step, then signs in with the resulting wallet. */
  const run = async (step: () => Promise<Wallet> | Wallet, after = "/wallet", pincode?: string) => {
    setBusy(true);
    setError(null);
    try {
      const w = await step();
      await login(w, pincode);
      router.push(after);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <Shell><p className="text-sm text-muted-foreground">Loading wallet…</p></Shell>;

  if (wallet && sessionKey === wallet.publicKey) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>You&apos;re signed in</CardTitle>
            <CardDescription>
              {wallet.kind === "freighter" ? "Freighter" : "Device wallet"} · <span className="font-mono">{shortAddress(wallet.publicKey)}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/wallet">Go to your wallet</Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>That didn&apos;t work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {wallet && !busy && (
        <Card>
          <CardHeader>
            <CardTitle>Sign in again</CardTitle>
            <CardDescription>
              Your {wallet.kind === "freighter" ? "Freighter account" : "device wallet"}{" "}
              <span className="font-mono">{shortAddress(wallet.publicKey)}</span> is connected but not signed in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" disabled={busy} onClick={() => run(() => wallet)}>
              Sign in
            </Button>
          </CardContent>
        </Card>
      )}

      {mode === "choose" && (
        <div className="grid gap-3">
          <Option
            icon={Puzzle}
            title="Connect Freighter"
            description="Use the Freighter browser extension. Switch it to Testnet first."
            disabled={busy}
            onClick={() => run(walletCtx.connectFreighter)}
          />
          {deviceWalletPublicKey ? (
            <Option
              icon={KeyRound}
              title="Use the wallet on this device"
              description={`${shortAddress(deviceWalletPublicKey)} · unlock it with your pincode.`}
              disabled={busy}
              onClick={() => run(walletCtx.selectDeviceWallet)}
            />
          ) : (
            <Option
              icon={KeyRound}
              title="Create a wallet on this device"
              description="Your browser makes the key and keeps it, encrypted under a pincode you choose."
              disabled={busy}
              onClick={() => setMode("create")}
            />
          )}
          {!deviceWalletPublicKey && (
            <Option
              icon={Upload}
              title="Import a backup"
              description="Restore a wallet you exported from Pairy in another browser."
              disabled={busy}
              onClick={() => setMode("import")}
            />
          )}
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
          onSubmit={(backup, pincode) => run(() => walletCtx.importDeviceWallet(backup, pincode), "/wallet", pincode)}
          onError={setError}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-4 px-4 py-6 md:py-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Get started</h1>
        <p className="text-sm text-muted-foreground">
          Pick a wallet, then sign a one-time message to sign in. Pairy never sees your key or your pincode.
        </p>
      </div>
      {children}
    </div>
  );
}

function Option({
  icon: Icon,
  title,
  description,
  disabled,
  onClick,
}: {
  icon: typeof KeyRound;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/50 disabled:opacity-50"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-pairy-flame/10 text-pairy-flame">
        <Icon className="size-5" />
      </span>
      <span className="space-y-0.5">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
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
    <Card>
      <CardHeader>
        <CardTitle>Create a wallet on this device</CardTitle>
        <CardDescription>Choose a pincode. You&apos;ll enter it every time you sign.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooShort && confirm === pincode) onSubmit(pincode);
          }}
        >
          <Alert>
            <AlertTitle>There is no copy on our server</AlertTitle>
            <AlertDescription className="space-y-1">
              <p>
                The key is made and kept only in this browser, encrypted with your pincode. Pairy can&apos;t see it and
                can&apos;t recover it.
              </p>
              <p>
                If you lose this device, clear this browser&apos;s data, or forget the pincode, this testnet wallet is
                gone. Export a backup from the Wallet page right after you create it.
              </p>
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="pincode">Pincode</Label>
            <Input
              id="pincode"
              type="password"
              autoComplete="new-password"
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least {PINCODE_MIN_LENGTH} characters.</p>
            {allDigits && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
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
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch && <p className="text-xs text-destructive">The pincodes don&apos;t match.</p>}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            <Button type="submit" className="flex-1" disabled={busy || tooShort || confirm !== pincode}>
              {busy ? "Creating…" : "Create wallet and sign in"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ImportForm({
  busy,
  onBack,
  onSubmit,
  onError,
}: {
  busy: boolean;
  onBack: () => void;
  onSubmit: (backup: unknown, pincode: string) => void;
  onError: (message: string) => void;
}) {
  const [backup, setBackup] = useState<unknown>(null);
  const [pincode, setPincode] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import a backup</CardTitle>
        <CardDescription>Choose the .json file you exported, and enter the pincode it was made with.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (backup) onSubmit(backup, pincode);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="backup">Backup file</Label>
            <Input
              id="backup"
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                setBackup(null);
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
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            <Button type="submit" className="flex-1" disabled={busy || !backup || pincode.length === 0}>
              {busy ? "Importing…" : "Import and sign in"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
