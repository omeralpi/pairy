'use client';

import { List, Map as MapIcon, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ListingCard } from "@/components/listing/listing-card";
import { countryName } from "@/components/listing/format";
import { ListingsMap, groupByCity } from "@/components/map";
import { api, type RouterInputs } from "@/lib/api";
import { FIAT_CODES } from "@/lib/fiat";
import { cn } from "@/lib/utils";

type Filters = Exclude<RouterInputs["listing"]["list"], void | undefined>;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium shadow-sm transition-colors",
        active ? "border-foreground bg-foreground text-background" : "bg-background/95 hover:border-foreground/50",
      )}
    >
      {children}
    </button>
  );
}

export default function MapPage() {
  const [filters, setFilters] = useState<Filters>({});
  const [view, setView] = useState<"map" | "list">("map");
  const [cityId, setCityId] = useState<string | null>(null);
  const { data, isLoading, error } = api.listing.list.useQuery(filters);
  const pins = useMemo(() => groupByCity(data ?? []), [data]);
  const selected = pins.find((p) => p.cityId === cityId) ?? null;

  const toggle = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="z-10 flex items-center gap-2 border-b bg-background py-2.5 pr-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pl-4 [scrollbar-width:none]">
          <Chip active={filters.side === "sell_crypto"} onClick={() => toggle("side", "sell_crypto")}>
            Selling crypto
          </Chip>
          <Chip active={filters.side === "buy_crypto"} onClick={() => toggle("side", "buy_crypto")}>
            Buying crypto
          </Chip>
          <span className="h-5 w-px shrink-0 bg-border" />
          {(["XLM", "USDC"] as const).map((a) => (
            <Chip key={a} active={filters.asset === a} onClick={() => toggle("asset", a)}>
              {a}
            </Chip>
          ))}
          <span className="h-5 w-px shrink-0 bg-border" />
          <select
            aria-label="Cash currency"
            value={filters.fiatCode ?? ""}
            onChange={(e) =>
              setFilters((f) => ({ ...f, fiatCode: (e.target.value || undefined) as Filters["fiatCode"] }))
            }
            className={cn(
              "shrink-0 rounded-full border bg-background px-3 py-1.5 text-sm font-medium shadow-sm",
              filters.fiatCode && "border-foreground",
            )}
          >
            <option value="">Any cash</option>
            {FIAT_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex shrink-0 rounded-full border p-0.5">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium capitalize",
                view === v ? "bg-foreground text-background" : "text-muted-foreground",
              )}
            >
              {v === "map" ? <MapIcon className="size-4" /> : <List className="size-4" />}
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="relative flex-1">
        {error && (
          <p className="absolute inset-x-4 top-4 z-20 rounded-lg bg-destructive p-3 text-sm text-destructive-foreground">
            Could not load listings: {error.message}
          </p>
        )}

        {view === "map" ? (
          <>
            <ListingsMap pins={pins} selectedCityId={cityId} onSelectCity={setCityId} />
            {!isLoading && pins.length === 0 && (
              <p className="pointer-events-none absolute inset-x-0 top-6 z-10 mx-auto w-fit rounded-full bg-background/95 px-4 py-2 text-sm shadow">
                No active listings match these filters yet.
              </p>
            )}
            {selected && (
              <section className="absolute inset-x-2 bottom-2 z-20 max-h-[55%] overflow-y-auto rounded-2xl border bg-background p-4 shadow-xl md:inset-x-auto md:bottom-auto md:left-4 md:top-4 md:max-h-[calc(100%-2rem)] md:w-96">
                <header className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <h2 className="font-display text-lg font-bold leading-tight">{selected.cityName}</h2>
                    <p className="text-sm text-muted-foreground">
                      {countryName(selected.countryCode)} · {selected.listings.length} listing
                      {selected.listings.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCityId(null)}
                    aria-label="Close"
                    className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
                  >
                    <X className="size-4" />
                  </button>
                </header>
                <div className="space-y-2">
                  {selected.listings.map((l) => (
                    <ListingCard key={l.id} listing={l} showCity={false} />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-2 p-4">
              {isLoading && <p className="text-sm text-muted-foreground">Loading listings…</p>}
              {!isLoading && data?.length === 0 && (
                <p className="text-sm text-muted-foreground">No active listings match these filters yet.</p>
              )}
              {data?.map((l) => <ListingCard key={l.id} listing={l} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
