'use client';

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Asks for the device wallet's pincode. `title` names what is being signed
 * ("Sign in", "Sign transaction") and is shown as the eyebrow. `onSubmit` does the signing; if it
 * throws, the message is shown and the user can retry. The pincode stays in
 * this component's state only until the dialog closes.
 */
export function PincodeDialog({
  open,
  title,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  onSubmit: (pincode: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [pincode, setPincode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPincode("");
    setError(null);
    setBusy(false);
  };

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
              This signs on this device. Your pincode and key are never sent to Pairy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pairy-pincode">Pincode</Label>
            <Input
              id="pairy-pincode"
              type="password"
              autoComplete="off"
              autoFocus
              className="font-mono"
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
              disabled={busy}
            />
            {error && (
              <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-danger">
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
