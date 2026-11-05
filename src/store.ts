// Extension state + every action the UI calls. The tree is mutated in place;
// `revision` is the change signal components subscribe to. Photo keyword
// writes go through the core catalogue store's addKeywords/removeKeywords — the
// only durable path, and the one that notifies sidecar writers (XMP Tools).

import { api } from "./runtime.ts";
import type { StoreHook } from "./safelight";
import { keyOf, normalizeKeywordName } from "./model/names.ts";
import {
  closureNameSet,
  collectNames,
  createNode,
  ensurePath,
  indexTree,
  mergeForest,
  moveNode,
  removeSubtree,
  renameNode,
  sanitizeForest,
  type KeywordNode,
  type KeywordTreeFile,
  type MergeStats,
  type TreeIndex,
} from "./model/tree.ts";
import { parseLrText, serializeLrText, type ParsedLrText } from "./model/lr-text.ts";

export const SETTING_TAG_ANCESTORS = "tagAncestors";
const SETTING_TREE = "tree";
const SETTING_PANEL_UI = "panelUi";
const PERSIST_DELAY_MS = 300;
const RECENT_LIMIT = 12;

export interface HKState {
  revision: number;
  roots: KeywordNode[];
  filterKeys: string[];
  expanded: string[];
  recent: string[];
  editingKey: string | null;
}

export let kw!: StoreHook<HKState>;

let persistTimer: number | undefined;
let uiTimer: number | undefined;
let learnTimer: number | undefined;
let learnQueue: string[][] = [];

export function initKeywordStore(): void {
  const treeFile = api.settings.get<Partial<KeywordTreeFile> | null>(SETTING_TREE, null);
  const panelUi = api.settings.get<{ expanded?: string[]; recent?: string[] }>(SETTING_PANEL_UI, {});

  kw = api.stores.create<HKState>(() => ({
    revision: 0,
    roots: sanitizeForest(treeFile?.roots),
    filterKeys: [],
    expanded: Array.isArray(panelUi.expanded) ? panelUi.expanded : [],
    recent: Array.isArray(panelUi.recent) ? panelUi.recent : [],
    editingKey: null,
  }));

  // Another window edited the tree: adopt it (onChange fires cross-window only).
  api.settings.onChange((key, value) => {
    if (key !== SETTING_TREE) return;
    const roots = sanitizeForest((value as Partial<KeywordTreeFile> | null)?.roots);
    kw.setState((s) => ({ roots, revision: s.revision + 1 }));
  });
}

function bump(): void {
  kw.setState((s) => ({ revision: s.revision + 1 }));
}

function persistTree(): void {
  if (persistTimer !== undefined) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(flushPersist, PERSIST_DELAY_MS);
}

export function flushPersist(): void {
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  try {
    const file: KeywordTreeFile = { version: 1, roots: kw.getState().roots };
    api.settings.set(SETTING_TREE, file);
  } catch (err) {
    console.warn("[hierarchical-keywording] failed to persist tree:", err);
  }
}

function persistPanelUi(): void {
  if (uiTimer !== undefined) window.clearTimeout(uiTimer);
  uiTimer = window.setTimeout(() => {
    uiTimer = undefined;
    const { expanded, recent } = kw.getState();
    api.settings.set(SETTING_PANEL_UI, { expanded, recent });
  }, PERSIST_DELAY_MS);
}

// ── selection targets (mirrors core's KeywordEditor) ─────────────────────────

export function targetIds(): string[] {
  const s = api.stores.useCatalogStore.getState();
  if (s.selectedIds.size > 1) return [...s.selectedIds];
  return s.activePhotoId ? [s.activePhotoId] : [];
}

// ── name helpers against live photos ─────────────────────────────────────────

/** Photo ids carrying the keyword, with the exact stored spellings found —
 *  removals must match the stored strings, which may differ in case. */
function occurrences(keys: Set<string>): { ids: string[]; variants: string[] } {
  const ids: string[] = [];
  const variants = new Set<string>();
  for (const photo of api.stores.useCatalogStore.getState().photos) {
    let hit = false;
    for (const stored of photo.keywords) {
      if (keys.has(keyOf(stored))) {
        variants.add(stored);
        hit = true;
      }
    }
    if (hit) ids.push(photo.id);
  }
  return { ids, variants: [...variants] };
}

function tagAncestors(): boolean {
  return api.settings.get(SETTING_TAG_ANCESTORS, false);
}

/** The names applying `key` writes onto a photo: the node's own name, plus its
 *  ancestors when the "tag ancestors" setting is on. */
function namesToApply(index: TreeIndex, key: string): string[] {
  const entry = index.get(key);
  if (!entry) return [];
  return tagAncestors() ? [...entry.path] : [entry.node.name];
}

function pushRecent(names: string[]): void {
  kw.setState((s) => {
    const next = [...names, ...s.recent.filter((r) => !names.some((n) => keyOf(n) === keyOf(r)))];
    return { recent: next.slice(0, RECENT_LIMIT) };
  });
  persistPanelUi();
}

// ── apply / remove ───────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: string[];
  created: string[];
  errors: string[];
}

/** Ensure every path exists, then tag the target photos with the leaves. */
export async function applyPaths(paths: string[][], ids: string[] = targetIds()): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], created: [], errors: [] };
  if (paths.length === 0) return result;

  const { roots } = kw.getState();
  const leafKeys: string[] = [];
  for (const path of paths) {
    const { leaf, createdNames, problem } = ensurePath(roots, path);
    if (problem || !leaf) {
      if (problem) result.errors.push(problem);
      continue;
    }
    result.created.push(...createdNames);
    leafKeys.push(keyOf(leaf.name));
  }

  if (result.created.length > 0) persistTree();

  if (ids.length > 0 && leafKeys.length > 0) {
    const index = indexTree(roots);
    const names = new Map<string, string>();
    for (const key of leafKeys) {
      for (const name of namesToApply(index, key)) names.set(keyOf(name), name);
    }
    try {
      await api.stores.useCatalogStore.getState().addKeywords(ids, [...names.values()]);
      result.applied = leafKeys.map((k) => index.get(k)!.node.name);
      pushRecent(result.applied);
    } catch (err) {
      result.errors.push(String(err));
    }
  } else if (ids.length === 0 && leafKeys.length > 0) {
    result.errors.push("No photo selected");
  }

  bump();
  return result;
}

export type CheckState = "on" | "mixed" | "off";

export function checkStateOf(have: number, total: number): CheckState {
  return have === 0 || total === 0 ? "off" : have === total ? "on" : "mixed";
}

/** keyword key → how many of `photos` carry it, each photo counted once. */
export function targetKeyCounts(photos: { keywords: string[] }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    const seen = new Set<string>();
    for (const stored of photo.keywords) {
      const key = keyOf(stored);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function checkStateFor(key: string, photos: { keywords: string[] }[]): CheckState {
  let have = 0;
  for (const photo of photos) {
    if (photo.keywords.some((k) => keyOf(k) === key)) have += 1;
  }
  return checkStateOf(have, photos.length);
}

/** Checkbox click: all targets have it → remove everywhere; else complete it. */
export async function toggleOnTargets(key: string): Promise<void> {
  const ids = targetIds();
  if (ids.length === 0) return;
  const catalog = api.stores.useCatalogStore.getState();
  const idSet = new Set(ids);
  const targets = catalog.photos.filter((p) => idSet.has(p.id));
  const state = checkStateFor(key, targets);

  if (state === "on") {
    const variants = new Set<string>();
    for (const photo of targets) {
      for (const stored of photo.keywords) if (keyOf(stored) === key) variants.add(stored);
    }
    await catalog.removeKeywords(ids, [...variants]);
  } else {
    const index = indexTree(kw.getState().roots);
    const entry = index.get(key);
    if (entry) {
      await catalog.addKeywords(ids, namesToApply(index, key));
      pushRecent([entry.node.name]);
    } else {
      // Unfiled keyword (on photos but not in the tree): reuse a stored spelling.
      const spellings = [...variantsOnPhotos(key)];
      if (spellings.length > 0) await catalog.addKeywords(ids, [spellings[0]]);
    }
  }
  bump();
}

function variantsOnPhotos(key: string): Set<string> {
  const variants = new Set<string>();
  for (const photo of api.stores.useCatalogStore.getState().photos) {
    for (const stored of photo.keywords) if (keyOf(stored) === key) variants.add(stored);
  }
  return variants;
}

export async function removeFromTargets(key: string): Promise<void> {
  const ids = targetIds();
  if (ids.length === 0) return;
  const variants = variantsOnPhotos(key);
  if (variants.size === 0) return;
  await api.stores.useCatalogStore.getState().removeKeywords(ids, [...variants]);
  bump();
}

// ── tree editing ─────────────────────────────────────────────────────────────

export interface RenameOutcome {
  ok: boolean;
  message: string | null;
}

/** Put back a tree snapshot taken before an edit whose photo write failed. */
function restoreTree(snapshot: KeywordNode[]): void {
  kw.setState({ roots: snapshot });
  persistTree();
  bump();
}

/** Rename the node and rewrite the keyword on every photo that carries it. */
export async function renameNodeAction(key: string, newName: string): Promise<RenameOutcome> {
  const { roots } = kw.getState();
  const before = occurrences(new Set([key]));
  const oldName = indexTree(roots).get(key)?.node.name ?? key;
  const snapshot = structuredClone(roots);
  const res = renameNode(roots, key, newName);

  if (res.kind === "invalid") return { ok: false, message: res.reason };
  if (res.kind === "missing") return { ok: false, message: "Keyword no longer exists" };

  const finalName = res.kind === "merged" ? res.into : indexTree(roots).get(keyOf(normalizeKeywordName(newName)))?.node.name;
  let warning: string | null = null;
  if (finalName && before.ids.length > 0) {
    const catalog = api.stores.useCatalogStore.getState();
    // The new name goes on first, so no failure can leave a photo without the keyword.
    try {
      await catalog.addKeywords(before.ids, [finalName]);
    } catch (err) {
      restoreTree(snapshot);
      return { ok: false, message: `Couldn't rename "${oldName}": ${String(err)}` };
    }
    // Core matches keywords exactly, so only spellings other than the final one go.
    const stale = before.variants.filter((v) => v !== finalName);
    if (stale.length > 0) {
      try {
        await catalog.removeKeywords(before.ids, stale);
      } catch (err) {
        warning = `Renamed to "${finalName}", but the old spelling may remain on some photos: ${String(err)}`;
      }
    }
  }

  const newKey = finalName ? keyOf(finalName) : key;
  kw.setState((s) => ({
    expanded: s.expanded.map((k) => (k === key ? newKey : k)),
    filterKeys: s.filterKeys.map((k) => (k === key ? newKey : k)),
    editingKey: s.editingKey === key ? newKey : s.editingKey,
  }));
  persistTree();
  persistPanelUi();
  bump();
  return {
    ok: true,
    message: warning ?? (res.kind === "merged" ? `Merged into "${res.into}"` : null),
  };
}

export interface DeletePreview {
  keywordCount: number;
  photoCount: number;
}

export function previewDelete(key: string): DeletePreview {
  const entry = indexTree(kw.getState().roots).get(key);
  if (!entry) return { keywordCount: 0, photoCount: 0 };
  const names = collectNames(entry.node);
  const keys = new Set(names.map(keyOf));
  return { keywordCount: names.length, photoCount: occurrences(keys).ids.length };
}

/** Delete the subtree and strip its keywords from every photo carrying them.
 *  Resolves to a message when the photo write failed and the tree was kept. */
export async function deleteNodeAction(key: string): Promise<string | null> {
  const { roots } = kw.getState();
  const snapshot = structuredClone(roots);
  const names = removeSubtree(roots, key);
  if (names.length === 0) return null;
  const keys = new Set(names.map(keyOf));
  const { ids, variants } = occurrences(keys);
  if (ids.length > 0) {
    try {
      await api.stores.useCatalogStore.getState().removeKeywords(ids, variants);
    } catch (err) {
      restoreTree(snapshot);
      return `Couldn't delete "${names[0]}": ${String(err)}`;
    }
  }
  kw.setState((s) => ({
    filterKeys: s.filterKeys.filter((k) => !keys.has(k)),
    expanded: s.expanded.filter((k) => !keys.has(k)),
    editingKey: s.editingKey && keys.has(s.editingKey) ? null : s.editingKey,
  }));
  persistTree();
  persistPanelUi();
  bump();
  return null;
}

export function moveNodeAction(key: string, newParentKey: string | null): boolean {
  const moved = moveNode(kw.getState().roots, key, newParentKey);
  if (moved) {
    if (newParentKey) expandNode(newParentKey);
    persistTree();
    bump();
  }
  return moved;
}

/** File an unfiled keyword (already on photos) into the tree at top level. */
export function addRootKeyword(name: string): void {
  mergeForest(kw.getState().roots, [createNode(name)]);
  persistTree();
  bump();
}

/** Create a fresh uniquely-named child (or root) and open it for rename. */
export function createChild(parentKey: string | null): string {
  const { roots } = kw.getState();
  const index = indexTree(roots);
  let name = "New Keyword";
  for (let n = 2; index.has(keyOf(name)); n++) name = `New Keyword ${n}`;
  const parent = parentKey ? index.get(parentKey)?.node ?? null : null;
  mergeForest(roots, [createNode(name)], index, parent);
  if (parentKey) expandNode(parentKey);
  const key = keyOf(name);
  kw.setState({ editingKey: key });
  persistTree();
  bump();
  return key;
}

export function setSynonyms(key: string, synonyms: string[]): void {
  const entry = indexTree(kw.getState().roots).get(key);
  if (!entry) return;
  entry.node.synonyms = [];
  const seen = new Set<string>();
  for (const syn of synonyms) {
    if (!seen.has(keyOf(syn))) {
      entry.node.synonyms.push(syn);
      seen.add(keyOf(syn));
    }
  }
  persistTree();
  bump();
}

export function setFlag(
  key: string,
  flag: "includeOnExport" | "exportParents" | "exportSynonyms",
  value: boolean,
): void {
  const entry = indexTree(kw.getState().roots).get(key);
  if (!entry) return;
  entry.node[flag] = value;
  persistTree();
  bump();
}

// ── expansion / editing / filtering ──────────────────────────────────────────

export function toggleExpanded(key: string): void {
  kw.setState((s) => ({
    expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key],
  }));
  persistPanelUi();
}

export function expandNode(key: string): void {
  kw.setState((s) => (s.expanded.includes(key) ? {} : { expanded: [...s.expanded, key] }));
  persistPanelUi();
}

export function setEditing(key: string | null): void {
  kw.setState({ editingKey: key });
}

/** Plain click filters by exactly this keyword (click again to clear);
 *  Ctrl/⌘-click adds or removes it as an OR term. */
export function toggleFilterKey(key: string, additive: boolean): void {
  kw.setState((s) => {
    if (additive) {
      return {
        filterKeys: s.filterKeys.includes(key)
          ? s.filterKeys.filter((k) => k !== key)
          : [...s.filterKeys, key],
      };
    }
    return { filterKeys: s.filterKeys.length === 1 && s.filterKeys[0] === key ? [] : [key] };
  });
}

export function clearFilter(): void {
  kw.setState({ filterKeys: [] });
}

/** The grid predicate for the current filter terms; null when inactive. */
export function currentFilterPredicate(): ((photo: { keywords: string[] }) => boolean) | null {
  const { filterKeys, roots } = kw.getState();
  if (filterKeys.length === 0) return null;
  const closure = closureNameSet(indexTree(roots), filterKeys);
  return (photo) => photo.keywords.some((k) => closure.has(keyOf(k)));
}

// ── import / export / learning ───────────────────────────────────────────────

export interface ImportOutcome {
  stats: MergeStats;
  parsed: ParsedLrText;
}

export function importLrText(text: string): ImportOutcome {
  const parsed = parseLrText(text);
  const stats = mergeForest(kw.getState().roots, parsed.roots);
  if (stats.added > 0 || stats.merged > 0) {
    persistTree();
    bump();
  }
  return { stats, parsed };
}

export function exportLrText(): string {
  return serializeLrText(kw.getState().roots);
}

/** Batch hierarchy learning during imports: paths queue up and fold into the
 *  tree once per debounce window, so a thousand-photo scan persists a handful
 *  of times instead of a thousand. */
export function learnPaths(paths: string[][]): void {
  if (paths.length === 0) return;
  learnQueue.push(...paths);
  if (learnTimer !== undefined) return;
  learnTimer = window.setTimeout(() => {
    learnTimer = undefined;
    const batch = learnQueue;
    learnQueue = [];
    const forest: KeywordNode[] = [];
    for (const path of batch) {
      let level = forest;
      for (const segment of path) {
        let node = level.find((n) => keyOf(n.name) === keyOf(segment));
        if (!node) {
          node = createNode(segment);
          level.push(node);
        }
        level = node.children;
      }
    }
    const stats = mergeForest(kw.getState().roots, forest);
    if (stats.added > 0) {
      persistTree();
      bump();
    }
  }, PERSIST_DELAY_MS);
}
