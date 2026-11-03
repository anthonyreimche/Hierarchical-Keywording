// Hierarchical Keywording — entry point. Registers the Keyword Tree panel,
// the tree-aware grid filter, the Library context-menu action, hierarchy
// learning from XMP sidecars on import, and the focus shortcut.

import { initRuntime } from "./runtime";
import type { SafelightAPI } from "./safelight";
import {
  clearFilter,
  currentFilterPredicate,
  flushPersist,
  initKeywordStore,
  kw,
  learnPaths,
  SETTING_TAG_ANCESTORS,
} from "./store";
import { readSidecarKeywords } from "./model/xmp-learn.ts";
import { keyOf } from "./model/names.ts";
import { KeywordTreePanel } from "./ui/KeywordTreePanel.tsx";
import { isPanelMounted, requestEntryFocus } from "./ui/hooks.ts";

const ID = "com.safelight.hierarchical-keywording";
const PANEL_ID = `${ID}.panel`;
const FILTER_ID = `${ID}.filter`;

export function activate(api: SafelightAPI): void {
  initRuntime(api);
  initKeywordStore();

  api.registerPanel({
    id: PANEL_ID,
    title: "Keyword Tree",
    component: KeywordTreePanel,
    defaultDock: { module: "library", direction: "left", order: 3, width: 260 },
  });

  // The grid predicate follows the panel's filter terms. Re-registering the
  // same id replaces the entry; tree edits re-derive the closure too, since a
  // rename or delete changes what a term covers.
  const syncFilter = () => {
    const predicate = currentFilterPredicate();
    api.registerGridFilter({
      id: FILTER_ID,
      test: predicate ?? (() => true),
      onClear: clearFilter,
    });
  };
  syncFilter();
  let hadFilter = false;
  kw.subscribe((s, prev) => {
    const has = s.filterKeys.length > 0;
    if (s.filterKeys !== prev.filterKeys || (has && s.revision !== prev.revision) || has !== hadFilter) {
      hadFilter = has;
      syncFilter();
    }
  });

  const openPanelAndFocus = (ids?: string[]) => {
    if (ids && ids.length > 0) {
      api.stores.useCatalogStore.setState({ selectedIds: new Set(ids), activePhotoId: ids[0] });
    }
    if (!isPanelMounted()) api.dock.togglePanel(PANEL_ID);
    requestEntryFocus();
  };

  api.registerGridMenuItem({
    id: `${ID}.add`,
    order: 12,
    label: (ids) => (ids.length > 1 ? `Add keywords… (${ids.length})` : "Add keywords…"),
    onClick: (ids) => openPanelAndFocus(ids),
  });

  api.registerKeybinding({
    id: `${ID}.focus`,
    label: "Focus keyword tree entry",
    category: "Library",
    defaultCombo: "Ctrl+K",
    handler: () => openPanelAndFocus(),
  });

  // Learn hierarchy from sidecars as photos come in: lr:hierarchicalSubject
  // paths fold into the tree, and the photo's flat keywords gain any
  // hierarchical leaves dc:subject missed. Existing keywords are kept.
  api.registerCatalogHooks({
    id: `${ID}.sidecar-learn`,
    async onPhotoImport({ photo, dir, fileName }) {
      const sidecar = await readSidecarKeywords(dir, fileName);
      if (!sidecar) return;
      learnPaths(sidecar.paths);

      const merged = [...photo.keywords];
      const have = new Set(merged.map(keyOf));
      const incoming = [...sidecar.flat, ...sidecar.paths.map((p) => p[p.length - 1])];
      for (const name of incoming) {
        if (!have.has(keyOf(name))) {
          merged.push(name);
          have.add(keyOf(name));
        }
      }
      if (merged.length !== photo.keywords.length) return { keywords: merged };
    },
  });

  api.registerSettings({
    title: "Hierarchical Keywording",
    fields: [
      {
        key: SETTING_TAG_ANCESTORS,
        label: "Also tag ancestor keywords on photos",
        hint: "Applying \"Eagle\" under Animals > Birds writes all three keywords onto the photo. Keeps the full hierarchy visible to apps that only read flat keywords; when off, parents stay implied by the tree.",
        type: "boolean",
        default: false,
      },
    ],
  });
}

export function deactivate(): void {
  // Contributions are swept by the host; only the debounced tree write needs
  // flushing so a quick disable can't lose the last edit.
  flushPersist();
}
