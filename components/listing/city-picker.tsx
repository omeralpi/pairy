'use client';

import { Check, ChevronsUpDown, MapPin } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, type RouterOutputs } from "@/lib/api";
import { cn } from "@/lib/utils";

import { countryName } from "./format";

export type PickedCity = RouterOutputs["geo"]["searchCities"][number];

/** Picks a city by name. Only its id is ever sent to the server; no device location is read. */
export function CityPicker({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: PickedCity | null;
  onChange: (c: PickedCity) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = api.geo.searchCities.useQuery(
    { q: debounced },
    { enabled: debounced.trim().length > 0, placeholderData: (prev) => prev },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className="flex h-14 w-full items-center gap-2.5 rounded-md border border-line bg-paper px-4 text-left text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
        >
          <MapPin className="size-4 shrink-0 text-slate" strokeWidth={1.5} />
          {value ? (
            <span className="truncate">
              {value.name}
              <span className="text-slate">
                {value.region && value.region !== value.name ? `, ${value.region}` : ""}, {countryName(value.countryCode)}
              </span>
            </span>
          ) : (
            <span className="text-slate">Search a city</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 text-slate" strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] border-line bg-paper p-0 shadow-sm" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Istanbul, Lagos, Buenos Aires…" value={q} onValueChange={setQ} />
          <CommandList>
            {debounced.trim() && !isFetching && <CommandEmpty>No city found.</CommandEmpty>}
            <CommandGroup>
              {(debounced.trim() ? data ?? [] : []).map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  // The highlighted row stays ink on sand, never slate on beacon.
                  className="py-2.5 text-ink data-[selected=true]:bg-sand data-[selected=true]:text-ink"
                  onSelect={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4 text-ink", value?.id === c.id ? "opacity-100" : "opacity-0")} strokeWidth={1.5} />
                  <span className="truncate">
                    {c.name}
                    <span className="text-slate">
                      {c.region && c.region !== c.name ? `, ${c.region}` : ""}, {countryName(c.countryCode)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <p className="border-t border-line px-3 py-2 text-[11px] text-slate">
            Cities with 100k+ people, from{" "}
            <a href="https://www.geonames.org/" target="_blank" rel="noreferrer" className="underline">
              GeoNames
            </a>{" "}
            (CC BY 4.0).
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
