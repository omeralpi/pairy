"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// Example cities for the headline only. They are not places Pairy "serves".
const CITIES = [
  "Lagos.",
  "Bogotá.",
  "Tbilisi.",
  "İstanbul.",
  "Buenos Aires.",
  "Nairobi.",
  "Manila.",
  "Lisbon.",
  "Accra.",
  "Hanoi.",
];
const N = CITIES.length;
// Three copies so there is always a line above and below the active one.
const TRACK = [...CITIES, ...CITIES, ...CITIES];
const START = N + CITIES.indexOf("İstanbul.");
const LINE = 1.15; // line height in em
const ROWS = 5; // visible lines; the active one sits in the middle
const STEP_MS = 2500;
const FADE =
  "linear-gradient(to bottom, rgba(0,0,0,0.12), #000 30%, #000 70%, rgba(0,0,0,0.12))";

/** The rotating city stack next to "Trade in". Decorative: the h1 carries the text for screen readers. */
export function CityRotator({ className }: { className?: string }) {
  const [{ pos, animate }, setState] = useState({ pos: START, animate: true });

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      // After a full cycle, jump back one copy without animating, then keep going.
      setState((s) => (s.pos >= 2 * N ? { pos: s.pos - N, animate: false } : { pos: s.pos + 1, animate: true }));
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (animate) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setState((s) => ({ pos: s.pos + 1, animate: true })));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [animate]);

  return (
    <div
      aria-hidden
      className={cn("relative overflow-hidden font-serif italic", className)}
      style={{ height: `${ROWS * LINE}em`, maskImage: FADE, WebkitMaskImage: FADE }}
    >
      <ul
        className={cn("motion-reduce:transition-none", animate && "transition-transform duration-700 ease-out")}
        style={{ transform: `translateY(${((ROWS - 1) / 2 - pos) * LINE}em)` }}
      >
        {TRACK.map((city, i) => {
          const distance = Math.abs(i - pos);
          return (
            <li
              key={i}
              className={cn(
                "whitespace-nowrap pr-[0.1em]",
                animate && "transition-colors duration-700 motion-reduce:transition-none",
                distance === 0 ? "text-beacon" : distance === 1 ? "text-slate" : "text-mist",
              )}
              style={{ height: `${LINE}em`, lineHeight: LINE }}
            >
              {city}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
