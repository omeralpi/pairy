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
export function CityPicker({ value, onChange }: { value: PickedCity | null; onChange: (c: PickedCity) => void }) {
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
          type="button"
          className="flex h-14 w-full items-center gap-2 rounded-md border border-input px-4 text-left"
        >
          <MapPin className="size-4 shrink-0 text-muted-foreground" />
          {value ? (
            <span className="truncate">
              {value.name}
              <span className="text-muted-foreground">
                {value.region && value.region !== value.name ? `, ${value.region}` : ""}, {countryName(value.countryCode)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Search a city</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Istanbul, Lagos, Buenos Aires…" value={q} onValueChange={setQ} />
          <CommandList>
            {debounced.trim() && !isFetching && <CommandEmpty>No city found.</CommandEmpty>}
            <CommandGroup>
              {(debounced.trim() ? data ?? [] : []).map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", value?.id === c.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">
                    {c.name}
                    <span className="text-muted-foreground">
                      {c.region && c.region !== c.name ? `, ${c.region}` : ""}, {countryName(c.countryCode)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
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
