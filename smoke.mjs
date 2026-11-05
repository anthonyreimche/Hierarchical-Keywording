// Smoke test against the built bundle: run `npm run smoke` (builds first).
// Mocks the SafelightAPI, drives activate() and the registered contributions,
// and checks registration shape, sidecar hierarchy learning, the keyword
// override returned to the import pipeline, and teardown flushing.
import assert from "node:assert";

globalThis.window ??= globalThis;

// ── mini zustand ─────────────────────────────────────────────────────────────
function makeStore(init) {
  let state;
  const listeners = new Set();
  const set = (partial) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    const prev = state;
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state, prev));
  };
  const get = () => state;
  state = typeof init === "function" ? init(set, get) : init;
  const hook = () => state;
  hook.getState = get;
  hook.setState = set;
  hook.subscribe = (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return hook;
}

// ── mocked catalogue ───────────────────────────────────────────────────────────
const calls = { addKeywords: [], removeKeywords: [], togglePanel: [] };
const photos = [
  { id: "p1", filename: "IMG_1.NEF", relPath: "IMG_1.NEF", keywords: ["trip"] },
  { id: "p2", filename: "IMG_2.NEF", relPath: "IMG_2.NEF", keywords: [] },
];
const useCatalogStore = makeStore((set, get) => ({
  photos,
  selectedIds: new Set(),
  activePhotoId: null,
  async addKeywords(ids, keywords) {
    calls.addKeywords.push({ ids, keywords });
    for (const p of get().photos) {
      if (!ids.includes(p.id)) continue;
      for (const k of keywords) if (!p.keywords.includes(k)) p.keywords.push(k);
    }
  },
  async removeKeywords(ids, keywords) {
    calls.removeKeywords.push({ ids, keywords });
    for (const p of get().photos) {
      if (!ids.includes(p.id)) continue;
      p.keywords = p.keywords.filter((k) => !keywords.includes(k));
    }
  },
  selectAll(ids) {
    set({ selectedIds: new Set(ids) });
  },
  setActivePhoto(id) {
    set({ activePhotoId: id });
  },
}));

// ── mocked settings / registry ───────────────────────────────────────────────
const settingsMap = new Map();
const registered = {};
const api = {
  version: 1,
  extensionId: "com.safelight.hierarchical-keywording",
  react: { createElement: () => null, Fragment: Symbol("Fragment") },
  ui: { tokens: {} },
  stores: { useCatalogStore, create: makeStore },
  dock: {
    togglePanel(id) {
      calls.togglePanel.push(id);
    },
  },
  settings: {
    get: (k, fb) => (settingsMap.has(k) ? settingsMap.get(k) : fb),
    set: (k, v) => settingsMap.set(k, v),
    onChange: () => () => {},
  },
  registerPanel: (c) => (registered.panel = c),
  registerGridFilter: (c) => (registered.filter = c),
  registerGridMenuItem: (c) => (registered.menu = c),
  registerCatalogHooks: (c) => (registered.hooks = c),
  registerSettings: (c) => (registered.settings = c),
  registerKeybinding: (c) => (registered.key = c),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mod = await import("./index.js");
assert.equal(typeof mod.activate, "function", "exports activate()");
assert.equal(typeof mod.deactivate, "function", "exports deactivate()");

mod.activate(api);

// Registrations
assert.equal(registered.panel?.title, "Keyword Tree");
assert.equal(registered.panel?.defaultDock?.module, "library");
assert.ok(registered.filter, "grid filter registered");
assert.ok(registered.hooks?.onPhotoImport, "import hook registered");
assert.equal(registered.key?.defaultCombo, "Ctrl+K");
assert.equal(registered.settings?.fields?.[0]?.key, "tagAncestors");
assert.equal(registered.menu.label(["a"]), "Add keywords…");
assert.equal(registered.menu.label(["a", "b"]), "Add keywords… (2)");

// Idle filter passes everything.
assert.equal(registered.filter.test(photos[0]), true);
assert.equal(registered.filter.test({ keywords: [] }), true);

// Grid menu targets the photos and opens the (unmounted) panel.
registered.menu.onClick(["p2"]);
assert.ok(useCatalogStore.getState().selectedIds.has("p2"));
assert.equal(useCatalogStore.getState().activePhotoId, "p2");
assert.equal(calls.togglePanel.length, 1);

// Keybinding handler is safe with nothing selected.
registered.key.handler();
assert.equal(calls.togglePanel.length, 2);

// Sidecar learning: hierarchy folds into the tree, flat keywords gain the
// hierarchical leaves, existing keywords stay.
const XMP = `<x:xmpmeta><rdf:RDF><rdf:Description
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:lr="http://ns.adobe.com/lightroom/1.0/">
  <dc:subject><rdf:Bag><rdf:li>Eagle</rdf:li><rdf:li>Alaska</rdf:li></rdf:Bag></dc:subject>
  <lr:hierarchicalSubject><rdf:Bag>
    <rdf:li>Animals|Birds|Eagle</rdf:li>
    <rdf:li>Places|Alaska</rdf:li>
  </rdf:Bag></lr:hierarchicalSubject>
</rdf:Description></rdf:RDF></x:xmpmeta>`;
const dir = {
  async getFileHandle(name) {
    assert.equal(name, "IMG_1.xmp");
    return { getFile: async () => ({ text: async () => XMP }) };
  },
};
const override = await registered.hooks.onPhotoImport({
  photo: photos[0],
  dir,
  fileName: "IMG_1.NEF",
});
assert.deepEqual(override, { keywords: ["trip", "Eagle", "Alaska"] });

// A photo already carrying everything gets no override.
const noop = await registered.hooks.onPhotoImport({
  photo: { ...photos[0], keywords: ["trip", "eagle", "ALASKA"] },
  dir,
  fileName: "IMG_1.NEF",
});
assert.equal(noop, undefined);

// The debounced learn pass (300ms) plus the debounced persist (300ms more).
await sleep(800);
const tree = settingsMap.get("tree");
assert.ok(tree, "tree persisted after learning");
const animals = tree.roots.find((r) => r.name === "Animals");
assert.equal(animals?.children?.[0]?.name, "Birds");
assert.equal(animals?.children?.[0]?.children?.[0]?.name, "Eagle");
assert.ok(tree.roots.find((r) => r.name === "Places"));

// Missing sidecar → no override, no crash.
const none = await registered.hooks.onPhotoImport({
  photo: photos[1],
  dir: {
    async getFileHandle() {
      throw new DOMException("not found", "NotFoundError");
    },
  },
  fileName: "IMG_2.NEF",
});
assert.equal(none, undefined);

mod.deactivate();

console.log("OK — all Hierarchical Keywording smoke assertions passed");
