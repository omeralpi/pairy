'use client';

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Asks for the device wallet's pincode. `onSubmit` does the signing; if it
 * throws, the message is shown and the user can retry. The pincode stays in
 * this component's state only until the dialog closes.
 */
export function PincodeDialog({
  open,
  title,
  description,
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
      <DialogContent className="max-w-sm">
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
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pairy-pincode">Pincode</Label>
            <Input
              id="pairy-pincode"
              type="password"
              autoComplete="off"
              autoFocus
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
              disabled={busy}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">Unlocking takes a second: the pincode is stretched with scrypt.</p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || pincode.length === 0}>
              {busy ? "Unlocking…" : "Unlock and sign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
