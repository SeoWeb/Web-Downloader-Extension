"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// In-app navigation trail (viewer back button): `document.referrer` is set
// once when the document loads and is never updated by SPA (client-side)
// navigations, so after an in-app navigation to the page view it is stale —
// and after a reload on the page-view URL it equals the current URL, making
// a referrer-based `router.push(current URL)` a visible no-op. Instead, the
// trail of visited paths is kept in sessionStorage (per-tab, survives
// reloads, dies with the tab) and back resolves by walking it backwards.
const TRAIL_KEY = "pp_nav_history";
const TRAIL_CAP = 25;

function readTrail(): string[] {
  try {
    const raw = sessionStorage.getItem(TRAIL_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Privacy mode / corrupted value — treat as an empty trail.
    return [];
  }
}

function writeTrail(trail: string[]) {
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
  } catch {
    // Privacy mode / quota — the trail is best-effort; back still resolves
    // (to the fallback when nothing was recorded).
  }
}

// Records the current `pathname + search` into the sessionStorage trail and
// exposes `goBack(fallback)`: walks the trail backwards, skipping entries
// identical to the current path (a reload re-records nothing, and ?format=
// param writes append variant entries), returning the first entry that
// starts with "/app" — else the fallback. Never returns the current path,
// so back can never be a visible no-op.
export function useNavTrail() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const query = searchParams.toString();
  const current = query ? `${pathname}?${query}` : pathname;

  // Latest observed location, readable from the stable goBack below even
  // when invoked from a hotkey handler created on the first render.
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    const trail = readTrail();
    if (trail[trail.length - 1] === current) return; // reload / re-render dedupe
    trail.push(current);
    if (trail.length > TRAIL_CAP) {
      trail.splice(0, trail.length - TRAIL_CAP);
    }
    writeTrail(trail);
  }, [current]);

  const goBack = useCallback((fallback: string): string => {
    const trail = readTrail();
    for (let i = trail.length - 1; i >= 0; i--) {
      const entry = trail[i];
      if (entry === undefined || entry === currentRef.current) continue;
      if (entry.startsWith("/app")) return entry;
    }
    return fallback;
  }, []);

  return goBack;
}
