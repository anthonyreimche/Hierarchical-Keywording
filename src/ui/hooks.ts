// Shared UI plumbing: selection targets (mirroring core's KeywordEditor
// semantics), the catalogue-wide keyword count index, and the entry-focus bus
// that lets the grid menu / shortcut reach the panel's input across mounts.

import { api, React } from "../runtime";
import type { CatalogPhoto } from "../safelight";
import { keyOf } from "../model/names.ts";

/** The photos keywording acts on: the multi-selection when there is one,
 *  otherwise the active photo (exactly what core's KeywordEditor targets). */
export function useTargetPhotos(): CatalogPhoto[] {
  const photos = api.stores.useCatalogStore((s) => s.photos);
  const selectedIds = api.stores.useCatalogStore((s) => s.selectedIds);
  const activeId = api.stores.useCatalogStore((s) => s.activePhotoId);
  return React.useMemo(() => {
    if (selectedIds.size > 1) return photos.filter((p) => selectedIds.has(p.id));
    if (activeId) {
      const active = photos.find((p) => p.id === activeId);
      return active ? [active] : [];
    }
    return [];
  }, [photos, selectedIds, activeId]);
}

export interface KeywordCount {
  display: string;
  count: number;
}

/** keyword key → catalogue-wide photo count (+ a display spelling seen on
 *  photos). Rebuilt only when the photos array identity changes. */
export function useKeywordCounts(): Map<string, KeywordCount> {
  const photos = api.stores.useCatalogStore((s) => s.photos);
  return React.useMemo(() => {
    const counts = new Map<string, KeywordCount>();
    for (const photo of photos) {
      const seen = new Set<string>();
      for (const stored of photo.keywords) {
        const key = keyOf(stored);
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = counts.get(key);
        if (hit) hit.count += 1;
        else counts.set(key, { display: stored, count: 1 });
      }
    }
    return counts;
  }, [photos]);
}

// ── entry focus bus ──────────────────────────────────────────────────────────

let pendingFocus = false;
let mounted = false;
const focusListeners = new Set<() => void>();

export function requestEntryFocus(): void {
  pendingFocus = true;
  focusListeners.forEach((l) => l());
}

export function isPanelMounted(): boolean {
  return mounted;
}

/** The entry field consumes pending focus requests (including one queued
 *  before the panel mounted). */
export function useEntryFocus(focus: () => void): void {
  React.useEffect(() => {
    mounted = true;
    const consume = () => {
      if (pendingFocus) {
        pendingFocus = false;
        focus();
      }
    };
    focusListeners.add(consume);
    consume();
    return () => {
      mounted = false;
      focusListeners.delete(consume);
    };
  }, [focus]);
}
