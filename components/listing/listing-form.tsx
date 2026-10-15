'use client';

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterInputs } from "@/lib/api";
import { FIAT_CODES } from "@/lib/fiat";
import { cn } from "@/lib/utils";

import { CityPicker, type PickedCity } from "./city-picker";

type CreateInput = RouterInputs["listing"]["create"];

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-flow-col auto-cols-fr rounded-xl border p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
            value === o.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return <p className="text-sm text-destructive">{messages[0]}</p>;
}

export function ListingForm() {
  const router = useRouter();
  const utils = api.useUtils();
  const [side, setSide] = useState<CreateInput["side"]>("sell_crypto");
  const [asset, setAsset] = useState<CreateInput["asset"]>("USDC");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [fiatCode, setFiatCode] = useState<CreateInput["fiatCode"]>("USD");
  const [rate, setRate] = useState("");
  const [city, setCity] = useState<PickedCity | null>(null);
  const [note, setNote] = useState("");

  const create = api.listing.create.useMutation({
    onSuccess: async (listing) => {
      await utils.listing.invalidate();
      router.push(`/listings/${listing.id}`);
    },
  });
  const fieldErrors = (create.error?.data?.zodError?.fieldErrors ?? {}) as Record<string, string[] | undefined>;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!city) return;
        create.mutate({ side, asset, minAmount, maxAmount, fiatCode, rate, cityId: city.id, note: note || undefined });
      }}
    >
      <div className="space-y-2">
        <Label>I want to</Label>
        <Segmented
          value={side}
          onChange={setSide}
          options={[
            { value: "sell_crypto", label: "Sell crypto for cash" },
            { value: "buy_crypto", label: "Buy crypto with cash" },
          ]}
        />
      </div>

      <div className="space-y-2">
        <Label>Asset (Stellar testnet)</Label>
        <Segmented
          value={asset}
          onChange={setAsset}
          options={[
            { value: "USDC", label: "USDC" },
            { value: "XLM", label: "XLM" },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="min">Min {asset}</Label>
          <Input id="min" inputMode="decimal" required placeholder="10" value={minAmount} onChange={(e) => setMinAmount(e.target.value.trim())} />
          <FieldError messages={fieldErrors.minAmount} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="max">Max {asset}</Label>
          <Input id="max" inputMode="decimal" required placeholder="500" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.trim())} />
          <FieldError messages={fieldErrors.maxAmount} />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <div className="space-y-2">
          <Label htmlFor="rate">Rate (cash per 1 {asset})</Label>
          <Input id="rate" inputMode="decimal" required placeholder="41.50" value={rate} onChange={(e) => setRate(e.target.value.trim())} />
          <FieldError messages={fieldErrors.rate} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fiat">Cash</Label>
          <select
            id="fiat"
            value={fiatCode}
            onChange={(e) => setFiatCode(e.target.value as CreateInput["fiatCode"])}
            className="flex h-14 w-full rounded-md border border-input bg-transparent px-3"
          >
            {FIAT_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>City</Label>
        <CityPicker value={city} onChange={setCity} />
        <p className="text-xs text-muted-foreground">
          Your listing shows at the city&apos;s centre, never at your position. Agree the exact meeting point in the
          trade chat.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="note">Note (optional)</Label>
        <Textarea
          id="note"
          rows={3}
          maxLength={280}
          placeholder="Usually free on weekday evenings. Public places only."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground">{note.length}/280</p>
        <FieldError messages={fieldErrors.note} />
      </div>

      {create.error && !create.error.data?.zodError && (
        <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{create.error.message}</p>
      )}

      <button
        type="submit"
        disabled={!city || create.isPending}
        className="h-12 w-full rounded-full bg-pairy-flame font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {create.isPending ? "Publishing…" : city ? "Publish listing" : "Pick a city to publish"}
      </button>
    </form>
  );
}
