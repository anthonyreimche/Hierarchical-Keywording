// Tree edits that rewrite photo keywords: the photo write comes before the tree
// is committed, and a failed write leaves both photos and tree as they were.
// Run: node --experimental-strip-types src/store.test.ts

import assert from "node:assert";
import { initRuntime } from "./runtime.ts";
import {
  checkStateOf,
  deleteNodeAction,
  flushPersist,
  initKeywordStore,
  kw,
  renameNodeAction,
  targetKeyCounts,
} from "./store.ts";
import { createNode, indexTree } from "./model/tree.ts";
import type { CatalogPhoto, CatalogState, SafelightAPI, StateCreator, StoreHook } from "./safelight";

(globalThis as { window?: typeof globalThis }).window = globalThis;

function makeStore<T>(init: StateCreator<T>): StoreHook<T> {
  let state: T;
  const listeners = new Set<(s: T, p: T) => void>();
  const set = (partial: Partial<T> | ((s: T) => Partial<T>)) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    const prev = state;
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state, prev));
  };
  state = init(set, () => state);
  const hook = (() => state) as StoreHook<T>;
  hook.getState = () => state;
  hook.setState = set;
  hook.subscribe = (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return hook;
}

const photo = (id: string, keywords: string[]): CatalogPhoto => ({ id, filename: `${id}.NEF`, relPath: `${id}.NEF`, keywords });

// Mirrors core: exact-string matching, in-memory change applied before the
// (possibly failing) storage write.
const failing = { add: false, remove: false };
const calls: string[] = [];
const useCatalogStore = makeStore<CatalogState>((set, get) => {
  const commit = (ids: string[], edit: (k: string[]) => string[], fail: boolean) => {
    const idSet = new Set(ids);
    set({ photos: get().photos.map((p) => (idSet.has(p.id) ? { ...p, keywords: edit(p.keywords) } : p)) });
    return fail ? Promise.reject(new Error("disk full")) : Promise.resolve();
  };
  return {
    photos: [],
    selectedIds: new Set<string>(),
    activePhotoId: null,
    addKeywords: (ids, keywords) => {
      calls.push(`add ${keywords.join(",")}`);
      if (failing.add) return Promise.reject(new Error("disk full"));
      return commit(ids, (k) => [...k, ...keywords.filter((w) => !k.includes(w))], false);
    },
    removeKeywords: (ids, keywords) => {
      calls.push(`remove ${keywords.join(",")}`);
      const drop = new Set(keywords);
      return commit(ids, (k) => k.filter((w) => !drop.has(w)), failing.remove);
    },
    selectAll: () => {},
    setActivePhoto: () => {},
  };
});

const settings = new Map<string, unknown>();
const api = {
  settings: {
    get: <T,>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    set: (key: string, value: unknown) => void settings.set(key, value),
    onChange: () => () => {},
  },
  stores: { useCatalogStore, create: makeStore },
} as unknown as SafelightAPI;

initRuntime(api);
initKeywordStore();

function reset(photos: CatalogPhoto[], names: string[]): void {
  failing.add = false;
  failing.remove = false;
  calls.length = 0;
  useCatalogStore.setState({ photos });
  const animals = createNode("Animals");
  animals.children = names.map((n) => createNode(n));
  kw.setState({ roots: [animals] });
}

const keywordsOf = (id: string) => useCatalogStore.getState().photos.find((p) => p.id === id)!.keywords;
const treeNames = () => [...indexTree(kw.getState().roots).values()].map((e) => e.node.name).sort();

// ── rename: add the new name first, remove only the stale spellings ───────────
{
  reset([photo("p1", ["dog"]), photo("p2", ["DOG", "Sun"])], ["Dog"]);
  const res = await renameNodeAction("dog", "Hound");
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ["add Hound", "remove dog,DOG"]);
  assert.deepEqual(keywordsOf("p1"), ["Hound"]);
  assert.deepEqual(keywordsOf("p2"), ["Sun", "Hound"]);
  assert.deepEqual(treeNames(), ["Animals", "Hound"]);
}

// ── rename: the typed name is normalized before photos are rewritten ──────────
{
  reset([photo("p1", ["Dog"])], ["Dog"]);
  kw.setState({ expanded: ["dog"], filterKeys: ["dog"], editingKey: "dog" });
  const res = await renameNodeAction("dog", "  Big   Hound ");
  assert.equal(res.ok, true);
  assert.deepEqual(keywordsOf("p1"), ["Big Hound"]);
  assert.deepEqual(treeNames(), ["Animals", "Big Hound"]);
  const s = kw.getState();
  assert.deepEqual([s.expanded, s.filterKeys, s.editingKey], [["big hound"], ["big hound"], "big hound"]);
}

// ── rename: a case-only rename never removes the final spelling ───────────────
{
  reset([photo("p1", ["dog"]), photo("p2", ["Dog"])], ["dog"]);
  const res = await renameNodeAction("dog", "Dog");
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ["add Dog", "remove dog"]);
  assert.deepEqual(keywordsOf("p1"), ["Dog"]);
  assert.deepEqual(keywordsOf("p2"), ["Dog"]);
}

// ── rename: addKeywords rejecting keeps the old keyword and the old tree ──────
{
  reset([photo("p1", ["Dog"]), photo("p2", ["Dog", "Sun"])], ["Dog"]);
  failing.add = true;
  const res = await renameNodeAction("dog", "Hound");
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /disk full/);
  assert.deepEqual(keywordsOf("p1"), ["Dog"]);
  assert.deepEqual(keywordsOf("p2"), ["Dog", "Sun"]);
  assert.deepEqual(treeNames(), ["Animals", "Dog"]);
  flushPersist();
  const saved = settings.get("tree") as { roots: { children: { name: string }[] }[] };
  assert.deepEqual(saved.roots[0].children.map((c) => c.name), ["Dog"]);
}

// ── rename merging into an existing keyword: same order, same rollback ────────
{
  reset([photo("p1", ["Pup"]), photo("p2", ["Dog"])], ["Dog", "Pup"]);
  failing.add = true;
  const res = await renameNodeAction("pup", "dog");
  assert.equal(res.ok, false);
  assert.deepEqual(keywordsOf("p1"), ["Pup"]);
  assert.deepEqual(treeNames(), ["Animals", "Dog", "Pup"]);
}

// ── rename: removing the stale spelling failing still leaves the new name ─────
{
  reset([photo("p1", ["Dog"])], ["Dog"]);
  failing.remove = true;
  const res = await renameNodeAction("dog", "Hound");
  assert.ok(keywordsOf("p1").includes("Hound"));
  assert.deepEqual(treeNames(), ["Animals", "Hound"]);
  assert.match(res.message ?? "", /disk full/);
}

// ── delete: removeKeywords rejecting restores the subtree ─────────────────────
{
  reset([photo("p1", ["Dog"])], ["Dog", "Cat"]);
  failing.remove = true;
  const message = await deleteNodeAction("animals");
  assert.match(message ?? "", /disk full/);
  assert.deepEqual(treeNames(), ["Animals", "Cat", "Dog"]);
}

// ── delete: success strips the subtree's keywords ─────────────────────────────
{
  reset([photo("p1", ["Dog", "Sun"])], ["Dog"]);
  const message = await deleteNodeAction("dog");
  assert.equal(message, null);
  assert.deepEqual(keywordsOf("p1"), ["Sun"]);
  assert.deepEqual(treeNames(), ["Animals"]);
}

// ── check states: one count map per render, each photo counted once ──────────
{
  const counts = targetKeyCounts([photo("a", ["Dog", "dog"]), photo("b", ["DOG"]), photo("c", ["Sun"])]);
  assert.equal(counts.get("dog"), 2);
  assert.equal(counts.get("sun"), 1);
  assert.equal(checkStateOf(counts.get("dog") ?? 0, 3), "mixed");
  assert.equal(checkStateOf(counts.get("cat") ?? 0, 3), "off");
  assert.equal(checkStateOf(3, 3), "on");
  assert.equal(checkStateOf(0, 0), "off");
}

flushPersist();
console.log("store tests passed");
