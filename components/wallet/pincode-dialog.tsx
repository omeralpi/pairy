'use client';

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Asks for the device wallet's pincode. `title` names what is being signed
 * ("Sign in", "Sign transaction") and is shown as the eyebrow; `summary` says
 * what the transaction does. `onSubmit` does the signing; if it
 * throws, the message is shown and the user can retry. The pincode stays in
 * this component's state only until the dialog closes.
 */
export function PincodeDialog({
  open,
  title,
  description,
  summary,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  summary?: string;
  onSubmit: (pincode: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [pincode, setPincode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPincode("");
    setError(null);
    setBusy(false);
  };

  // Closed from outside (the request was withdrawn): drop what was typed.
  useEffect(() => {
    if (open) return;
    setPincode("");
    setError(null);
    setBusy(false);
  }, [open]);

  // The field is disabled while signing, which drops focus to the page body;
  // put it back once a wrong pincode re-enables it, so the retry can be typed.
  useEffect(() => {
    if (error) input.current?.focus();
  }, [error]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          reset();
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-sm border-line bg-paper shadow-none sm:rounded-xl">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await onSubmit(pincode);
              reset();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Something went wrong.");
              setBusy(false);
            }
          }}
        >
          <DialogHeader className="space-y-2 text-left">
            {title && <p className="eyebrow">{title}</p>}
            <DialogTitle className="text-xl font-semibold tracking-tight">Sign with your pincode</DialogTitle>
            <DialogDescription className="text-sm text-slate">
              {description || "This signs on this device."} Your pincode and key are never sent to Pairy.
            </DialogDescription>
          </DialogHeader>
          {summary && (
            <p className="rounded-md bg-sand px-3 py-2.5 font-mono text-sm text-ink [overflow-wrap:anywhere]">
              {summary}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="pairy-pincode">Pincode</Label>
            <Input
              id="pairy-pincode"
              ref={input}
              type="password"
              autoComplete="off"
              autoFocus
              className="font-mono"
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? "pairy-pincode-error" : undefined}
            />
            {error && (
              <p id="pairy-pincode-error" role="alert" className="border-l-2 border-danger pl-3 text-sm text-danger [overflow-wrap:anywhere]">
                {error}
              </p>
            )}
            <p className="text-xs text-slate">Unlocking takes a second or two.</p>
          </div>
          <DialogFooter>
            <Button type="submit" className="w-full sm:w-auto" disabled={busy || pincode.length === 0}>
              {busy ? "Signing…" : "Sign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
