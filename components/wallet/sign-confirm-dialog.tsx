'use client';

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** DECISIONS 12: the one line shown before the SEP-53 login signature. */
export const PRIVY_LOGIN_TEXT = "Sign in: this signs a message and moves no funds";

/**
 * Pairy's own "what you are signing" screen, shown before every Privy
 * signature (DECISIONS 12): Privy receives a 32-byte hash it cannot describe,
 * so this dialog does. `title` names what is being signed ("Sign in", "Sign
 * transaction") and is shown as the eyebrow; `summary` says what the
 * transaction does. `onConfirm` does the signing; if it throws, the message
 * is shown and the user can retry or cancel.
 */
export function SignConfirmDialog({
  open,
  title,
  description,
  summary,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  summary?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Closed from outside (the request was withdrawn): forget the last error.
  useEffect(() => {
    if (open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  const cancel = () => {
    setError(null);
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) cancel();
      }}
    >
      <DialogContent className="max-w-sm border-line bg-paper shadow-none sm:rounded-xl">
        <SignConfirmContent
          title={title}
          description={description}
          summary={summary}
          busy={busy}
          error={error}
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Something went wrong.");
            } finally {
              setBusy(false);
            }
          }}
          onCancel={cancel}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's body, on its own so tests can see each state's markup without a browser. */
export function SignConfirmContent({
  title,
  description,
  summary,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  summary?: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <DialogHeader className="space-y-2 text-left">
        <p className="eyebrow">{title}</p>
        <DialogTitle className="text-xl font-semibold tracking-tight">Confirm with Privy</DialogTitle>
        <DialogDescription className="text-sm text-slate">
          {description} Privy receives only the hash of this; Pairy never sees the key.
        </DialogDescription>
      </DialogHeader>
      {summary && (
        <p className="whitespace-pre-wrap rounded-md bg-sand px-3 py-2.5 font-mono text-sm text-ink [overflow-wrap:anywhere]">
          {summary}
        </p>
      )}
      {error && (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={busy} onClick={() => void onConfirm()}>
          {busy ? "Waiting for Privy…" : "Sign"}
        </Button>
      </DialogFooter>
    </div>
  );
}
