//#region src/runtime.ts
let React;
let api;
let ui;
function initRuntime(a) {
	api = a;
	React = a.react;
	ui = a.ui;
}
//#endregion
//#region src/model/names.ts
const FORBIDDEN = /[|>,[\]{}\t]/;
/** Trim and collapse internal whitespace runs to single spaces. */
function normalizeKeywordName(raw) {
	return raw.trim().replace(/\s+/g, " ");
}
/** Case-folded identity key for a (normalized) keyword name. */
function keyOf(name) {
	return name.toLowerCase();
}
/** null when the (already normalized) name is usable, else the reason. */
function nameProblem(name) {
	if (name.length === 0) return "empty name";
	const hit = FORBIDDEN.exec(name);
	if (hit) return `"${hit[0]}" is not allowed in keyword names`;
	return null;
}
//#endregion
//#region src/model/tree.ts
function createNode(name, init) {
	const synonyms = [];
	const seen = /* @__PURE__ */ new Set();
	for (const syn of init?.synonyms ?? []) if (!seen.has(keyOf(syn))) {
		synonyms.push(syn);
		seen.add(keyOf(syn));
	}
	return {
		name,
		synonyms,
		includeOnExport: init?.includeOnExport ?? true,
		exportParents: init?.exportParents ?? true,
		exportSynonyms: init?.exportSynonyms ?? true,
		children: []
	};
}
function indexTree(roots) {
	const index = /* @__PURE__ */ new Map();
	const walk = (nodes, parent, prefix) => {
		for (const node of nodes) {
			const path = [...prefix, node.name];
			index.set(keyOf(node.name), {
				node,
				parent,
				path
			});
			walk(node.children, node, path);
		}
	};
	walk(roots, null, []);
	return index;
}
function siblingsOf(roots, parent) {
	return parent ? parent.children : roots;
}
function detach(roots, index, key) {
	const entry = index.get(key);
	if (!entry) return null;
	const siblings = siblingsOf(roots, entry.parent);
	const at = siblings.indexOf(entry.node);
	if (at !== -1) siblings.splice(at, 1);
	return entry;
}
const byName = (a, b) => keyOf(a.name).localeCompare(keyOf(b.name));
/** Lightroom keeps keyword lists alphabetical; so do we, at every mutation. */
function sortTree(roots) {
	roots.sort(byName);
	for (const node of roots) sortTree(node.children);
}
function mergeProps(into, from) {
	const have = new Set(into.synonyms.map(keyOf));
	for (const syn of from.synonyms) if (!have.has(keyOf(syn))) {
		into.synonyms.push(syn);
		have.add(keyOf(syn));
	}
	into.includeOnExport = into.includeOnExport && from.includeOnExport;
	into.exportParents = into.exportParents && from.exportParents;
	into.exportSynonyms = into.exportSynonyms && from.exportSynonyms;
}
/** Fold a forest of incoming nodes into the tree. An incoming name that exists
*  anywhere keeps the incumbent node in place (unique-name policy) and merges
*  props; its children then merge under that incumbent, not the incoming
*  parent. Nodes are cloned in — the incoming forest is never aliased. */
function mergeForest(roots, incoming, index = indexTree(roots), under = null) {
	const stats = {
		added: 0,
		merged: 0
	};
	const walk = (nodes, target) => {
		for (const inc of nodes) {
			const name = normalizeKeywordName(inc.name);
			if (nameProblem(name)) {
				walk(inc.children, target);
				continue;
			}
			const existing = index.get(keyOf(name));
			if (existing) {
				mergeProps(existing.node, inc);
				stats.merged += 1;
				walk(inc.children, existing.node);
			} else {
				const clone = createNode(name, inc);
				siblingsOf(roots, target).push(clone);
				index.set(keyOf(name), {
					node: clone,
					parent: target,
					path: []
				});
				stats.added += 1;
				walk(inc.children, clone);
			}
		}
	};
	walk(incoming, under);
	sortTree(roots);
	return stats;
}
/** Resolve a path of raw segment names, creating what's missing. An existing
*  name anywhere in the tree wins over the typed position (unique-name
*  policy), and the walk continues under it. */
function ensurePath(roots, rawPath) {
	const index = indexTree(roots);
	const createdNames = [];
	let cursor = null;
	for (const raw of rawPath) {
		const name = normalizeKeywordName(raw);
		const problem = nameProblem(name);
		if (problem) return {
			leaf: null,
			createdNames,
			problem
		};
		const existing = index.get(keyOf(name));
		if (existing) {
			cursor = existing.node;
			continue;
		}
		const node = createNode(name);
		siblingsOf(roots, cursor).push(node);
		index.set(keyOf(name), {
			node,
			parent: cursor,
			path: []
		});
		createdNames.push(name);
		cursor = node;
	}
	sortTree(roots);
	return {
		leaf: cursor,
		createdNames,
		problem: null
	};
}
/** Rename in place; renaming onto an existing name merges this node (and its
*  subtree) into the incumbent. */
function renameNode(roots, key, rawNewName) {
	const newName = normalizeKeywordName(rawNewName);
	const problem = nameProblem(newName);
	if (problem) return {
		kind: "invalid",
		reason: problem
	};
	const index = indexTree(roots);
	const entry = index.get(key);
	if (!entry) return { kind: "missing" };
	const newKey = keyOf(newName);
	if (newKey === key) {
		entry.node.name = newName;
		return { kind: "renamed" };
	}
	const incumbent = index.get(newKey);
	if (!incumbent) {
		entry.node.name = newName;
		sortTree(roots);
		return { kind: "renamed" };
	}
	detach(roots, index, key);
	for (const name of collectNames(entry.node)) index.delete(keyOf(name));
	mergeProps(incumbent.node, entry.node);
	mergeForest(roots, entry.node.children, index, incumbent.node);
	sortTree(roots);
	return {
		kind: "merged",
		into: incumbent.node.name
	};
}
/** Re-parent a node (null = top level). Refuses cycles and no-ops. */
function moveNode(roots, key, newParentKey) {
	const index = indexTree(roots);
	const entry = index.get(key);
	if (!entry) return false;
	let target = null;
	if (newParentKey !== null) {
		target = index.get(newParentKey) ?? null;
		if (!target) return false;
		if (target.path.some((name) => keyOf(name) === key)) return false;
	}
	if ((target?.node ?? null) === entry.parent) return false;
	detach(roots, index, key);
	siblingsOf(roots, target?.node ?? null).push(entry.node);
	sortTree(roots);
	return true;
}
/** Remove a subtree; returns every removed keyword name (for photo cleanup). */
function removeSubtree(roots, key) {
	const entry = detach(roots, indexTree(roots), key);
	return entry ? collectNames(entry.node) : [];
}
/** This node's name plus every descendant name, depth-first. */
function collectNames(node) {
	const names = [];
	const walk = (n) => {
		names.push(n.name);
		n.children.forEach(walk);
	};
	walk(node);
	return names;
}
/** Case-folded name set covering each key's node and all its descendants.
*  Keys with no node (e.g. unfiled keywords) contribute themselves, so the
*  same filter machinery covers tree and non-tree keywords alike. */
function closureNameSet(index, keys) {
	const set = /* @__PURE__ */ new Set();
	for (const key of keys) {
		const entry = index.get(key);
		if (!entry) {
			set.add(key);
			continue;
		}
		for (const name of collectNames(entry.node)) set.add(keyOf(name));
	}
	return set;
}
/** Rebuild a trustworthy forest from persisted (or foreign) JSON: coerce
*  shapes, drop unusable names, and fold duplicate names together so the
*  unique-name invariant holds from the first read. */
function sanitizeForest(input) {
	const coerce = (value) => {
		if (typeof value !== "object" || value === null) return null;
		const raw = value;
		const name = normalizeKeywordName(typeof raw.name === "string" ? raw.name : "");
		if (nameProblem(name)) return null;
		const node = createNode(name, {
			synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.filter((s) => typeof s === "string").map(normalizeKeywordName).filter((s) => !nameProblem(s)) : [],
			includeOnExport: raw.includeOnExport !== false,
			exportParents: raw.exportParents !== false,
			exportSynonyms: raw.exportSynonyms !== false
		});
		if (Array.isArray(raw.children)) for (const child of raw.children) {
			const coerced = coerce(child);
			if (coerced) node.children.push(coerced);
		}
		return node;
	};
	const forest = [];
	if (Array.isArray(input)) for (const value of input) {
		const node = coerce(value);
		if (node) forest.push(node);
	}
	const roots = [];
	mergeForest(roots, forest);
	return roots;
}
//#endregion
//#region src/model/lr-text.ts
function parseLrText(text) {
	const roots = [];
	const errors = [];
	let keywordCount = 0;
	let synonymCount = 0;
	const stack = [];
	const lines = text.split(/\r\n?|\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) continue;
		const tabs = /^\t*/.exec(line)[0].length;
		const spaces = tabs === 0 ? /^ */.exec(line)[0].length : 0;
		const depth = tabs > 0 ? tabs : Math.floor(spaces / 4);
		const content = line.trim();
		const at = `line ${i + 1}`;
		const synonym = /^\{(.*)\}$/.exec(content);
		if (synonym) {
			const owner = stack[depth - 1];
			if (!owner) {
				errors.push(`${at}: synonym "${synonym[1]}" has no keyword above it`);
				continue;
			}
			const name = normalizeKeywordName(synonym[1]);
			const problem = nameProblem(name);
			if (problem) {
				errors.push(`${at}: ${problem}`);
				continue;
			}
			if (!owner.synonyms.some((s) => s.toLowerCase() === name.toLowerCase())) {
				owner.synonyms.push(name);
				synonymCount += 1;
			}
			continue;
		}
		const excluded = /^\[(.*)\]$/.exec(content);
		const name = normalizeKeywordName(excluded ? excluded[1] : content);
		const problem = nameProblem(name);
		if (problem) {
			errors.push(`${at}: ${problem}`);
			continue;
		}
		if (depth > stack.length) {
			errors.push(`${at}: "${name}" skips an indentation level`);
			continue;
		}
		const node = createNode(name, { includeOnExport: !excluded });
		if (depth === 0) roots.push(node);
		else stack[depth - 1].children.push(node);
		stack[depth] = node;
		stack.length = depth + 1;
		keywordCount += 1;
	}
	return {
		roots,
		keywordCount,
		synonymCount,
		errors
	};
}
function serializeLrText(roots) {
	const lines = [];
	const walk = (nodes, depth) => {
		const indent = "	".repeat(depth);
		for (const node of nodes) {
			lines.push(indent + (node.includeOnExport ? node.name : `[${node.name}]`));
			for (const syn of node.synonyms) lines.push(`${indent}\t{${syn}}`);
			walk(node.children, depth + 1);
		}
	};
	walk(roots, 0);
	return lines.join("\n") + (lines.length ? "\n" : "");
}
//#endregion
//#region src/store.ts
const SETTING_TAG_ANCESTORS = "tagAncestors";
const SETTING_TREE = "tree";
const SETTING_PANEL_UI = "panelUi";
const PERSIST_DELAY_MS = 300;
const RECENT_LIMIT = 12;
let kw;
let persistTimer;
let uiTimer;
let learnTimer;
let learnQueue = [];
function initKeywordStore() {
	const treeFile = api.settings.get(SETTING_TREE, null);
	const panelUi = api.settings.get(SETTING_PANEL_UI, {});
	kw = api.stores.create(() => ({
		revision: 0,
		roots: sanitizeForest(treeFile?.roots),
		filterKeys: [],
		expanded: Array.isArray(panelUi.expanded) ? panelUi.expanded : [],
		recent: Array.isArray(panelUi.recent) ? panelUi.recent : [],
		editingKey: null
	}));
	api.settings.onChange((key, value) => {
		if (key !== SETTING_TREE) return;
		const roots = sanitizeForest(value?.roots);
		kw.setState((s) => ({
			roots,
			revision: s.revision + 1
		}));
	});
}
function bump() {
	kw.setState((s) => ({ revision: s.revision + 1 }));
}
function persistTree() {
	if (persistTimer !== void 0) window.clearTimeout(persistTimer);
	persistTimer = window.setTimeout(flushPersist, PERSIST_DELAY_MS);
}
function flushPersist() {
	if (persistTimer !== void 0) {
		window.clearTimeout(persistTimer);
		persistTimer = void 0;
	}
	try {
		const file = {
			version: 1,
			roots: kw.getState().roots
		};
		api.settings.set(SETTING_TREE, file);
	} catch (err) {
		console.warn("[hierarchical-keywording] failed to persist tree:", err);
	}
}
function persistPanelUi() {
	if (uiTimer !== void 0) window.clearTimeout(uiTimer);
	uiTimer = window.setTimeout(() => {
		uiTimer = void 0;
		const { expanded, recent } = kw.getState();
		api.settings.set(SETTING_PANEL_UI, {
			expanded,
			recent
		});
	}, PERSIST_DELAY_MS);
}
function targetIds() {
	const s = api.stores.useCatalogStore.getState();
	if (s.selectedIds.size > 1) return [...s.selectedIds];
	return s.activePhotoId ? [s.activePhotoId] : [];
}
/** Photo ids carrying the keyword, with the exact stored spellings found —
*  removals must match the stored strings, which may differ in case. */
function occurrences(keys) {
	const ids = [];
	const variants = /* @__PURE__ */ new Set();
	for (const photo of api.stores.useCatalogStore.getState().photos) {
		let hit = false;
		for (const stored of photo.keywords) if (keys.has(keyOf(stored))) {
			variants.add(stored);
			hit = true;
		}
		if (hit) ids.push(photo.id);
	}
	return {
		ids,
		variants: [...variants]
	};
}
function tagAncestors() {
	return api.settings.get(SETTING_TAG_ANCESTORS, false);
}
/** The names applying `key` writes onto a photo: the node's own name, plus its
*  ancestors when the "tag ancestors" setting is on. */
function namesToApply(index, key) {
	const entry = index.get(key);
	if (!entry) return [];
	return tagAncestors() ? [...entry.path] : [entry.node.name];
}
function pushRecent(names) {
	kw.setState((s) => {
		return { recent: [...names, ...s.recent.filter((r) => !names.some((n) => keyOf(n) === keyOf(r)))].slice(0, RECENT_LIMIT) };
	});
	persistPanelUi();
}
/** Ensure every path exists, then tag the target photos with the leaves. */
async function applyPaths(paths, ids = targetIds()) {
	const result = {
		applied: [],
		created: [],
		errors: []
	};
	if (paths.length === 0) return result;
	const { roots } = kw.getState();
	const leafKeys = [];
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
		const names = /* @__PURE__ */ new Map();
		for (const key of leafKeys) for (const name of namesToApply(index, key)) names.set(keyOf(name), name);
		try {
			await api.stores.useCatalogStore.getState().addKeywords(ids, [...names.values()]);
			result.applied = leafKeys.map((k) => index.get(k).node.name);
			pushRecent(result.applied);
		} catch (err) {
			result.errors.push(String(err));
		}
	} else if (ids.length === 0 && leafKeys.length > 0) result.errors.push("No photo selected");
	bump();
	return result;
}
function checkStateFor(key, photos) {
	if (photos.length === 0) return "off";
	let have = 0;
	for (const photo of photos) if (photo.keywords.some((k) => keyOf(k) === key)) have += 1;
	return have === 0 ? "off" : have === photos.length ? "on" : "mixed";
}
/** Checkbox click: all targets have it → remove everywhere; else complete it. */
async function toggleOnTargets(key) {
	const ids = targetIds();
	if (ids.length === 0) return;
	const catalog = api.stores.useCatalogStore.getState();
	const targets = catalog.photos.filter((p) => ids.includes(p.id));
	if (checkStateFor(key, targets) === "on") {
		const variants = /* @__PURE__ */ new Set();
		for (const photo of targets) for (const stored of photo.keywords) if (keyOf(stored) === key) variants.add(stored);
		await catalog.removeKeywords(ids, [...variants]);
	} else {
		const index = indexTree(kw.getState().roots);
		const entry = index.get(key);
		if (entry) {
			await catalog.addKeywords(ids, namesToApply(index, key));
			pushRecent([entry.node.name]);
		} else {
			const spellings = [...variantsOnPhotos(key)];
			if (spellings.length > 0) await catalog.addKeywords(ids, [spellings[0]]);
		}
	}
	bump();
}
function variantsOnPhotos(key) {
	const variants = /* @__PURE__ */ new Set();
	for (const photo of api.stores.useCatalogStore.getState().photos) for (const stored of photo.keywords) if (keyOf(stored) === key) variants.add(stored);
	return variants;
}
async function removeFromTargets(key) {
	const ids = targetIds();
	if (ids.length === 0) return;
	const variants = variantsOnPhotos(key);
	if (variants.size === 0) return;
	await api.stores.useCatalogStore.getState().removeKeywords(ids, [...variants]);
	bump();
}
/** Rename the node and rewrite the keyword on every photo that carries it. */
async function renameNodeAction(key, newName) {
	const { roots } = kw.getState();
	const before = occurrences(/* @__PURE__ */ new Set([key]));
	const res = renameNode(roots, key, newName);
	if (res.kind === "invalid") return {
		ok: false,
		message: res.reason
	};
	if (res.kind === "missing") return {
		ok: false,
		message: "Keyword no longer exists"
	};
	const finalName = res.kind === "merged" ? res.into : indexTree(roots).get(keyOf(newName))?.node.name;
	if (finalName && before.ids.length > 0) {
		const catalog = api.stores.useCatalogStore.getState();
		await catalog.removeKeywords(before.ids, before.variants);
		await catalog.addKeywords(before.ids, [finalName]);
	}
	const newKey = finalName ? keyOf(finalName) : key;
	kw.setState((s) => ({
		expanded: s.expanded.map((k) => k === key ? newKey : k),
		filterKeys: s.filterKeys.map((k) => k === key ? newKey : k),
		editingKey: s.editingKey === key ? newKey : s.editingKey
	}));
	persistTree();
	persistPanelUi();
	bump();
	return {
		ok: true,
		message: res.kind === "merged" ? `Merged into "${res.into}"` : null
	};
}
function previewDelete(key) {
	const entry = indexTree(kw.getState().roots).get(key);
	if (!entry) return {
		keywordCount: 0,
		photoCount: 0
	};
	const names = collectNames(entry.node);
	const keys = new Set(names.map(keyOf));
	return {
		keywordCount: names.length,
		photoCount: occurrences(keys).ids.length
	};
}
/** Delete the subtree and strip its keywords from every photo carrying them. */
async function deleteNodeAction(key) {
	const { roots } = kw.getState();
	const names = removeSubtree(roots, key);
	if (names.length === 0) return;
	const keys = new Set(names.map(keyOf));
	const { ids, variants } = occurrences(keys);
	if (ids.length > 0) await api.stores.useCatalogStore.getState().removeKeywords(ids, variants);
	kw.setState((s) => ({
		filterKeys: s.filterKeys.filter((k) => !keys.has(k)),
		expanded: s.expanded.filter((k) => !keys.has(k)),
		editingKey: s.editingKey && keys.has(s.editingKey) ? null : s.editingKey
	}));
	persistTree();
	persistPanelUi();
	bump();
}
function moveNodeAction(key, newParentKey) {
	const moved = moveNode(kw.getState().roots, key, newParentKey);
	if (moved) {
		if (newParentKey) expandNode(newParentKey);
		persistTree();
		bump();
	}
	return moved;
}
/** File an unfiled keyword (already on photos) into the tree at top level. */
function addRootKeyword(name) {
	mergeForest(kw.getState().roots, [createNode(name)]);
	persistTree();
	bump();
}
/** Create a fresh uniquely-named child (or root) and open it for rename. */
function createChild(parentKey) {
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
function setSynonyms(key, synonyms) {
	const entry = indexTree(kw.getState().roots).get(key);
	if (!entry) return;
	entry.node.synonyms = [];
	const seen = /* @__PURE__ */ new Set();
	for (const syn of synonyms) if (!seen.has(keyOf(syn))) {
		entry.node.synonyms.push(syn);
		seen.add(keyOf(syn));
	}
	persistTree();
	bump();
}
function setFlag(key, flag, value) {
	const entry = indexTree(kw.getState().roots).get(key);
	if (!entry) return;
	entry.node[flag] = value;
	persistTree();
	bump();
}
function toggleExpanded(key) {
	kw.setState((s) => ({ expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key] }));
	persistPanelUi();
}
function expandNode(key) {
	kw.setState((s) => s.expanded.includes(key) ? {} : { expanded: [...s.expanded, key] });
	persistPanelUi();
}
function setEditing(key) {
	kw.setState({ editingKey: key });
}
/** Plain click filters by exactly this keyword (click again to clear);
*  Ctrl/⌘-click adds or removes it as an OR term. */
function toggleFilterKey(key, additive) {
	kw.setState((s) => {
		if (additive) return { filterKeys: s.filterKeys.includes(key) ? s.filterKeys.filter((k) => k !== key) : [...s.filterKeys, key] };
		return { filterKeys: s.filterKeys.length === 1 && s.filterKeys[0] === key ? [] : [key] };
	});
}
function clearFilter() {
	kw.setState({ filterKeys: [] });
}
/** The grid predicate for the current filter terms; null when inactive. */
function currentFilterPredicate() {
	const { filterKeys, roots } = kw.getState();
	if (filterKeys.length === 0) return null;
	const closure = closureNameSet(indexTree(roots), filterKeys);
	return (photo) => photo.keywords.some((k) => closure.has(keyOf(k)));
}
function importLrText(text) {
	const parsed = parseLrText(text);
	const stats = mergeForest(kw.getState().roots, parsed.roots);
	if (stats.added > 0 || stats.merged > 0) {
		persistTree();
		bump();
	}
	return {
		stats,
		parsed
	};
}
function exportLrText() {
	return serializeLrText(kw.getState().roots);
}
/** Batch hierarchy learning during imports: paths queue up and fold into the
*  tree once per debounce window, so a thousand-photo scan persists a handful
*  of times instead of a thousand. */
function learnPaths(paths) {
	if (paths.length === 0) return;
	learnQueue.push(...paths);
	if (learnTimer !== void 0) return;
	learnTimer = window.setTimeout(() => {
		learnTimer = void 0;
		const batch = learnQueue;
		learnQueue = [];
		const forest = [];
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
		if (mergeForest(kw.getState().roots, forest).added > 0) {
			persistTree();
			bump();
		}
	}, PERSIST_DELAY_MS);
}
//#endregion
//#region src/model/xmp-learn.ts
const RAW_EXT = /^(nef|cr2|cr3|crw|dng|arw|orf|raf|rw2|pef|srw|3fr|dcr|erf|kdc|mos|raw|nrw)$/i;
/** Adobe sidecar naming: DSC_0012.NEF → DSC_0012.xmp; DSC_0012.JPG →
*  DSC_0012_jpg.xmp (so RAW+JPEG pairs keep distinct sidecars). */
function sidecarNameFor(imageFilename) {
	const dot = imageFilename.lastIndexOf(".");
	if (dot === -1) return `${imageFilename}.xmp`;
	const base = imageFilename.slice(0, dot);
	const ext = imageFilename.slice(dot + 1);
	return RAW_EXT.test(ext) ? `${base}.xmp` : `${base}_${ext.toLowerCase()}.xmp`;
}
function unescapeXml(text) {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10))).replace(/&amp;/g, "&");
}
function bagItems(xml, element) {
	const bag = new RegExp(`<${element}>\\s*<rdf:(?:Bag|Seq)>([\\s\\S]*?)</rdf:(?:Bag|Seq)>\\s*</${element}>`).exec(xml);
	if (!bag) return [];
	const items = [];
	const li = /<rdf:li[^>]*>([^<]*)<\/rdf:li>/g;
	let m;
	while ((m = li.exec(bag[1])) !== null) {
		const value = unescapeXml(m[1]).trim();
		if (value.length > 0) items.push(value);
	}
	return items;
}
function extractKeywordData(xml) {
	return {
		flat: bagItems(xml, "dc:subject"),
		paths: bagItems(xml, "lr:hierarchicalSubject").map((entry) => entry.split("|").map((s) => s.trim()).filter((s) => s.length > 0)).filter((path) => path.length > 0)
	};
}
/** Read and extract the sidecar for one image; null when there is none. */
async function readSidecarKeywords(dir, imageFilename) {
	try {
		const data = extractKeywordData(await (await (await dir.getFileHandle(sidecarNameFor(imageFilename))).getFile()).text());
		return data.flat.length || data.paths.length ? data : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/model/paths.ts
function parseEntry(raw) {
	const paths = [];
	const errors = [];
	for (const term of raw.split(",")) {
		if (term.trim().length === 0) continue;
		const segments = term.split(/[>|]/).map(normalizeKeywordName).filter((s) => s.length > 0);
		if (segments.length === 0) continue;
		const bad = segments.map(nameProblem).find((p) => p !== null);
		if (bad) {
			errors.push(`"${term.trim()}": ${bad}`);
			continue;
		}
		paths.push(segments);
	}
	return {
		paths,
		errors
	};
}
//#endregion
//#region src/ui/hooks.ts
/** The photos keywording acts on: the multi-selection when there is one,
*  otherwise the active photo (exactly what core's KeywordEditor targets). */
function useTargetPhotos() {
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
	}, [
		photos,
		selectedIds,
		activeId
	]);
}
/** keyword key → catalog-wide photo count (+ a display spelling seen on
*  photos). Rebuilt only when the photos array identity changes. */
function useKeywordCounts() {
	const photos = api.stores.useCatalogStore((s) => s.photos);
	return React.useMemo(() => {
		const counts = /* @__PURE__ */ new Map();
		for (const photo of photos) {
			const seen = /* @__PURE__ */ new Set();
			for (const stored of photo.keywords) {
				const key = keyOf(stored);
				if (seen.has(key)) continue;
				seen.add(key);
				const hit = counts.get(key);
				if (hit) hit.count += 1;
				else counts.set(key, {
					display: stored,
					count: 1
				});
			}
		}
		return counts;
	}, [photos]);
}
let pendingFocus = false;
let mounted = false;
const focusListeners = /* @__PURE__ */ new Set();
function requestEntryFocus() {
	pendingFocus = true;
	focusListeners.forEach((l) => l());
}
function isPanelMounted() {
	return mounted;
}
/** The entry field consumes pending focus requests (including one queued
*  before the panel mounted). */
function useEntryFocus(focus) {
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
//#endregion
//#region src/ui/EntryField.tsx
const MAX_SUGGESTIONS = 8;
function EntryField({ onNotice }) {
	const revision = kw((s) => s.revision);
	const recent = kw((s) => s.recent);
	const targets = useTargetPhotos();
	const counts = useKeywordCounts();
	const [value, setValue] = React.useState("");
	const [openList, setOpenList] = React.useState(false);
	const [hi, setHi] = React.useState(0);
	const boxRef = React.useRef(null);
	useEntryFocus(React.useCallback(() => {
		boxRef.current?.querySelector("input")?.focus();
	}, []));
	const vocabulary = React.useMemo(() => {
		const index = indexTree(kw.getState().roots);
		const entries = [];
		for (const { node, path } of index.values()) {
			const pathLabel = path.join(" > ");
			entries.push({
				match: node.name,
				insert: node.name,
				context: pathLabel
			});
			for (const syn of node.synonyms) entries.push({
				match: syn,
				insert: node.name,
				context: `synonym of ${pathLabel}`
			});
		}
		for (const [key, { display }] of counts) if (!index.has(key)) entries.push({
			match: display,
			insert: display,
			context: "unfiled"
		});
		return entries;
	}, [revision, counts]);
	const term = value.slice(value.lastIndexOf(",") + 1).trim();
	const suggestions = React.useMemo(() => {
		if (term.length === 0) return [];
		const needle = term.toLowerCase();
		const starts = [];
		const contains = [];
		const seen = /* @__PURE__ */ new Set();
		for (const { match, insert, context } of vocabulary) {
			const hay = match.toLowerCase();
			if (hay === needle || seen.has(keyOf(insert))) continue;
			if (hay.startsWith(needle)) starts.push({
				insert,
				context
			});
			else if (hay.includes(needle)) contains.push({
				insert,
				context
			});
			else continue;
			seen.add(keyOf(insert));
		}
		return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
	}, [term, vocabulary]);
	React.useEffect(() => setHi(0), [term]);
	const acceptSuggestion = (s) => {
		const head = value.slice(0, value.lastIndexOf(",") + 1);
		const next = head.length ? `${head} ${s.insert}` : s.insert;
		setValue(next);
		setOpenList(false);
		return next;
	};
	const apply = async (raw) => {
		const { paths, errors } = parseEntry(raw);
		if (paths.length === 0 && errors.length === 0) return;
		const result = await applyPaths(paths);
		const problems = [...errors, ...result.errors];
		if (problems.length > 0) {
			onNotice({
				tone: "warn",
				text: problems[0]
			});
			return;
		}
		setValue("");
		setOpenList(false);
		if (result.applied.length > 0) onNotice({
			tone: "info",
			text: targets.length > 1 ? `Applied ${result.applied.length} keyword${result.applied.length > 1 ? "s" : ""} to ${targets.length} photos` : `Applied ${result.applied.join(", ")}`
		});
		else if (result.created.length > 0) onNotice({
			tone: "info",
			text: `Created ${result.created.join(", ")} (no photo selected)`
		});
	};
	return /* @__PURE__ */ React.createElement("div", {
		ref: boxRef,
		style: { position: "relative" }
	}, /* @__PURE__ */ React.createElement(ui.TextInput, {
		value,
		onChange: (v) => {
			setValue(v);
			setOpenList(true);
		},
		placeholder: targets.length > 1 ? `Add keywords to ${targets.length} photos…` : "Add keywords…",
		onKeyDown: (e) => {
			if (e.key === "ArrowDown" && suggestions.length > 0) {
				e.preventDefault();
				e.stopPropagation();
				setOpenList(true);
				setHi((h) => (h + 1) % suggestions.length);
			} else if (e.key === "ArrowUp" && suggestions.length > 0) {
				e.preventDefault();
				e.stopPropagation();
				setHi((h) => (h + suggestions.length - 1) % suggestions.length);
			} else if (e.key === "Tab" && openList && suggestions[hi]) {
				e.preventDefault();
				e.stopPropagation();
				acceptSuggestion(suggestions[hi]);
			} else if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				const raw = openList && suggestions[hi] ? acceptSuggestion(suggestions[hi]) : value;
				apply(raw);
			} else if (e.key === "Escape" && openList) {
				e.stopPropagation();
				setOpenList(false);
			}
		},
		onBlur: () => window.setTimeout(() => setOpenList(false), 120)
	}), openList && suggestions.length > 0 && /* @__PURE__ */ React.createElement("div", { style: {
		position: "absolute",
		top: "100%",
		left: 0,
		right: 0,
		marginTop: 2,
		zIndex: 50,
		background: ui.tokens.surface1,
		border: `1px solid ${ui.tokens.border}`,
		borderRadius: 6,
		overflow: "hidden",
		boxShadow: "0 6px 20px rgba(0,0,0,0.35)"
	} }, suggestions.map((s, i) => /* @__PURE__ */ React.createElement("div", {
		key: `${s.insert}:${s.context}`,
		onMouseDown: (e) => {
			e.preventDefault();
			apply(acceptSuggestion(s));
		},
		onMouseEnter: () => setHi(i),
		style: {
			display: "flex",
			gap: 8,
			alignItems: "baseline",
			padding: "4px 8px",
			fontSize: 12,
			cursor: "pointer",
			background: i === hi ? ui.tokens.surface2 : "transparent"
		}
	}, /* @__PURE__ */ React.createElement("span", { style: { color: ui.tokens.textPrimary } }, s.insert), /* @__PURE__ */ React.createElement("span", { style: {
		color: ui.tokens.textMuted,
		fontSize: 10,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	} }, s.context)))), recent.length > 0 && /* @__PURE__ */ React.createElement(ui.Row, {
		gap: 4,
		wrap: true,
		style: { marginTop: 6 }
	}, recent.map((name) => /* @__PURE__ */ React.createElement("button", {
		key: name,
		title: `Apply "${name}"`,
		onClick: () => void applyPaths([[name]]),
		style: {
			border: `1px solid ${ui.tokens.borderSubtle}`,
			background: ui.tokens.surface2,
			color: ui.tokens.textSecondary,
			borderRadius: 10,
			fontSize: 10,
			lineHeight: "16px",
			padding: "0 7px",
			cursor: "pointer"
		}
	}, name))));
}
//#endregion
//#region src/ui/NodeEditor.tsx
function NodeEditor({ data, armDelete, onNotice, onClose }) {
	const { node, key } = data;
	const [synText, setSynText] = React.useState(node.synonyms.join(", "));
	const [confirming, setConfirming] = React.useState(armDelete);
	const parentOptions = React.useMemo(() => {
		const index = indexTree(kw.getState().roots);
		const inBranch = new Set(collectNames(node).map(keyOf));
		const options = [{
			value: "",
			label: "(top level)"
		}];
		const entries = [...index.entries()].filter(([k]) => !inBranch.has(k)).sort((a, b) => a[1].path.join("\0").localeCompare(b[1].path.join("\0")));
		for (const [k, entry] of entries) options.push({
			value: k,
			label: entry.path.join(" > ")
		});
		return options;
	}, [node]);
	const parentKey = React.useMemo(() => {
		const entry = indexTree(kw.getState().roots).get(key);
		return entry?.parent ? keyOf(entry.parent.name) : "";
	}, [key]);
	const commitSynonyms = () => {
		const parts = synText.split(",").map(normalizeKeywordName).filter((s) => s.length > 0);
		const bad = parts.find((s) => nameProblem(s));
		if (bad) {
			onNotice(`Synonym "${bad}": ${nameProblem(bad)}`);
			return;
		}
		setSynonyms(key, parts);
	};
	const preview = confirming ? previewDelete(key) : null;
	return /* @__PURE__ */ React.createElement("div", { style: {
		margin: `2px 4px 6px ${data.depth * 14 + 19}px`,
		padding: 8,
		background: ui.tokens.surface1,
		border: `1px solid ${ui.tokens.borderSubtle}`,
		borderRadius: 6
	} }, /* @__PURE__ */ React.createElement(ui.Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(ui.Field, {
		label: "Synonyms",
		hint: "Comma-separated; matched by autocomplete and search."
	}, /* @__PURE__ */ React.createElement(ui.TextInput, {
		value: synText,
		onChange: setSynText,
		placeholder: "e.g. raptor, bird of prey",
		onBlur: commitSynonyms,
		onKeyDown: (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				commitSynonyms();
			}
		}
	})), /* @__PURE__ */ React.createElement(ui.Toggle, {
		checked: node.includeOnExport,
		onChange: (v) => setFlag(key, "includeOnExport", v),
		label: "Include on export"
	}), /* @__PURE__ */ React.createElement(ui.Toggle, {
		checked: node.exportParents,
		onChange: (v) => setFlag(key, "exportParents", v),
		label: "Export parent keywords"
	}), /* @__PURE__ */ React.createElement(ui.Toggle, {
		checked: node.exportSynonyms,
		onChange: (v) => setFlag(key, "exportSynonyms", v),
		label: "Export synonyms"
	}), /* @__PURE__ */ React.createElement(ui.Field, { label: "Parent" }, /* @__PURE__ */ React.createElement(ui.Select, {
		value: parentKey,
		onChange: (v) => {
			if (!moveNodeAction(key, v === "" ? null : v)) onNotice("Can't move a keyword into its own branch");
		},
		options: parentOptions,
		ariaLabel: "Parent keyword"
	})), confirming && preview ? /* @__PURE__ */ React.createElement(ui.Stack, { gap: 6 }, /* @__PURE__ */ React.createElement("div", { style: {
		fontSize: 11,
		lineHeight: 1.5,
		color: ui.tokens.textSecondary
	} }, "Deletes", " ", /* @__PURE__ */ React.createElement("strong", null, preview.keywordCount, " keyword", preview.keywordCount !== 1 ? "s" : ""), " ", preview.photoCount > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, "and removes their tags from", " ", /* @__PURE__ */ React.createElement("strong", null, preview.photoCount, " photo", preview.photoCount !== 1 ? "s" : ""), ".") : "(no photos are tagged with them)."), /* @__PURE__ */ React.createElement(ui.Row, { gap: 6 }, /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "danger",
		size: "sm",
		onClick: () => {
			deleteNodeAction(key).then(onClose);
		}
	}, "Delete"), /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		onClick: () => setConfirming(false)
	}, "Cancel"))) : /* @__PURE__ */ React.createElement(ui.Row, {
		gap: 6,
		justify: "space-between"
	}, /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		onClick: () => setConfirming(true)
	}, "Delete…"), /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "secondary",
		size: "sm",
		onClick: onClose
	}, "Done"))));
}
//#endregion
//#region src/ui/TreeRow.tsx
const DND_KEYWORD = "application/x-hk-keyword";
const DND_PHOTOS = "application/x-safelight-photos";
function TreeRow(props) {
	const { data, hasChildren, expanded, checkState, count, deepCount, filterActive } = props;
	const [hover, setHover] = React.useState(false);
	const [dropping, setDropping] = React.useState(false);
	const acceptsDrop = (e) => (e.dataTransfer.types.includes("application/x-hk-keyword") || e.dataTransfer.types.includes("application/x-safelight-photos")) && !props.unfiled;
	return /* @__PURE__ */ React.createElement("div", {
		draggable: !props.renaming && !props.unfiled,
		onDragStart: (e) => {
			e.dataTransfer.setData(DND_KEYWORD, data.key);
			e.dataTransfer.effectAllowed = "move";
		},
		onDragOver: (e) => {
			if (!acceptsDrop(e)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-safelight-photos") ? "copy" : "move";
			setDropping(true);
		},
		onDragLeave: () => setDropping(false),
		onDrop: (e) => {
			setDropping(false);
			if (!acceptsDrop(e)) return;
			e.preventDefault();
			e.stopPropagation();
			const photoJson = e.dataTransfer.getData(DND_PHOTOS);
			if (photoJson) {
				try {
					const ids = JSON.parse(photoJson);
					if (Array.isArray(ids) && ids.length > 0) applyPaths([[data.node.name]], ids).then(() => props.onNotice(`Tagged ${ids.length} photo${ids.length > 1 ? "s" : ""} with "${data.node.name}"`));
				} catch {}
				return;
			}
			const dragged = e.dataTransfer.getData(DND_KEYWORD);
			if (dragged && dragged !== data.key && !moveNodeAction(dragged, data.key)) props.onNotice("Can't move a keyword into its own branch");
		},
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
		onContextMenu: (e) => {
			e.preventDefault();
			props.onOpenMenu(e, data);
		},
		style: {
			display: "flex",
			alignItems: "center",
			gap: 5,
			padding: "1px 4px 1px 0",
			paddingLeft: data.depth * 14,
			borderRadius: 4,
			background: dropping ? ui.tokens.surface3 : hover ? ui.tokens.surface2 : "transparent",
			outline: dropping ? `1px solid ${ui.tokens.accent}` : "none"
		}
	}, hasChildren ? /* @__PURE__ */ React.createElement("span", {
		onClick: () => toggleExpanded(data.key),
		title: expanded ? "Collapse" : "Expand",
		style: {
			width: 14,
			textAlign: "center",
			fontSize: 9,
			color: ui.tokens.textMuted,
			cursor: "pointer",
			userSelect: "none",
			transform: expanded ? "rotate(90deg)" : "none"
		}
	}, "▶") : /* @__PURE__ */ React.createElement("span", { style: { width: 14 } }), /* @__PURE__ */ React.createElement(TriCheck, {
		state: checkState,
		onClick: () => void toggleOnTargets(data.key)
	}), props.renaming ? /* @__PURE__ */ React.createElement(RenameInput, {
		data,
		onDone: props.onRenameEnd,
		onNotice: props.onNotice
	}) : /* @__PURE__ */ React.createElement("span", {
		onDoubleClick: props.unfiled ? void 0 : () => props.onRenameStart(),
		title: data.node.synonyms.length > 0 ? `Synonyms: ${data.node.synonyms.join(", ")}` : void 0,
		style: {
			flex: 1,
			minWidth: 0,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			fontSize: 12,
			color: props.unfiled ? ui.tokens.textSecondary : ui.tokens.textPrimary,
			fontStyle: props.unfiled ? "italic" : "normal",
			userSelect: "none"
		}
	}, data.node.name, !data.node.includeOnExport && /* @__PURE__ */ React.createElement("span", {
		title: "Excluded from export",
		style: { color: ui.tokens.textMuted }
	}, " ", "⊘")), /* @__PURE__ */ React.createElement("span", {
		onClick: (e) => toggleFilterKey(data.key, e.ctrlKey || e.metaKey),
		title: (deepCount !== count ? `${count} photos (${deepCount} incl. children) — ` : `${count} photos — `) + "click to filter, Ctrl+click to add to filter",
		style: {
			fontSize: 10,
			fontFamily: ui.tokens.fontMono,
			lineHeight: "14px",
			minWidth: 18,
			textAlign: "center",
			borderRadius: 7,
			padding: "0 4px",
			cursor: "pointer",
			userSelect: "none",
			color: filterActive ? ui.tokens.surface0 : ui.tokens.textMuted,
			background: filterActive ? ui.tokens.accent : "transparent"
		}
	}, count), /* @__PURE__ */ React.createElement("span", {
		onClick: (e) => props.onOpenMenu(e, data),
		title: "Keyword menu",
		style: {
			width: 16,
			textAlign: "center",
			cursor: "pointer",
			color: ui.tokens.textMuted,
			fontSize: 12,
			userSelect: "none",
			visibility: hover ? "visible" : "hidden"
		}
	}, "⋯"));
}
function TriCheck({ state, onClick }) {
	return /* @__PURE__ */ React.createElement("span", {
		onClick,
		role: "checkbox",
		"aria-checked": state === "on" ? "true" : state === "mixed" ? "mixed" : "false",
		title: state === "on" ? "Remove from selected photos" : "Apply to selected photos",
		style: {
			width: 13,
			height: 13,
			flexShrink: 0,
			borderRadius: 3,
			border: `1px solid ${state === "off" ? ui.tokens.border : ui.tokens.accent}`,
			background: state === "on" ? ui.tokens.accent : "transparent",
			color: state === "on" ? ui.tokens.surface0 : ui.tokens.accent,
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			fontSize: 9,
			lineHeight: 1,
			cursor: "pointer",
			userSelect: "none"
		}
	}, state === "on" ? "✓" : state === "mixed" ? "–" : "");
}
function RenameInput({ data, onDone, onNotice }) {
	const [name, setName] = React.useState(data.node.name);
	const boxRef = React.useRef(null);
	React.useEffect(() => {
		const input = boxRef.current?.querySelector("input");
		input?.focus();
		input?.select();
	}, []);
	const commit = async () => {
		if (name.trim() && name !== data.node.name) {
			const res = await renameNodeAction(data.key, name);
			if (res.message) onNotice(res.message);
		}
		onDone();
	};
	return /* @__PURE__ */ React.createElement("span", {
		ref: boxRef,
		style: {
			flex: 1,
			minWidth: 0
		}
	}, /* @__PURE__ */ React.createElement(ui.TextInput, {
		value: name,
		onChange: setName,
		onKeyDown: (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				commit();
			} else if (e.key === "Escape") {
				e.stopPropagation();
				onDone();
			}
		},
		onBlur: () => void commit()
	}));
}
//#endregion
//#region src/ui/menu.tsx
function uiZoom() {
	if (typeof getComputedStyle !== "function") return 1;
	const raw = getComputedStyle(document.body).zoom;
	const zoom = parseFloat(raw ?? "1");
	return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}
function useMenu() {
	const [open, setOpen] = React.useState(null);
	const openMenu = React.useCallback((e, items) => {
		const zoom = uiZoom();
		setOpen({
			x: e.clientX / zoom,
			y: e.clientY / zoom,
			items
		});
	}, []);
	React.useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") setOpen(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);
	return {
		menu: !open ? null : /* @__PURE__ */ React.createElement("div", {
			style: {
				position: "fixed",
				inset: 0,
				zIndex: 60
			},
			onClick: () => setOpen(null),
			onContextMenu: (e) => {
				e.preventDefault();
				setOpen(null);
			}
		}, /* @__PURE__ */ React.createElement("div", {
			style: {
				position: "fixed",
				left: open.x,
				top: open.y,
				minWidth: 160,
				padding: 4,
				background: ui.tokens.surface1,
				border: `1px solid ${ui.tokens.border}`,
				borderRadius: 6,
				boxShadow: "0 6px 20px rgba(0,0,0,0.35)"
			},
			onClick: (e) => e.stopPropagation()
		}, open.items.map((item) => /* @__PURE__ */ React.createElement(MenuRow, {
			key: item.label,
			item,
			close: () => setOpen(null)
		})))),
		openMenu
	};
}
function MenuRow({ item, close }) {
	const [hover, setHover] = React.useState(false);
	return /* @__PURE__ */ React.createElement("div", {
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
		onClick: () => {
			if (item.disabled) return;
			close();
			item.onClick();
		},
		style: {
			padding: "5px 10px",
			borderRadius: 4,
			fontSize: 12,
			cursor: item.disabled ? "default" : "pointer",
			opacity: item.disabled ? .45 : 1,
			color: item.danger ? "#e5484d" : ui.tokens.textPrimary,
			background: hover && !item.disabled ? ui.tokens.surface2 : "transparent",
			userSelect: "none"
		}
	}, item.label);
}
//#endregion
//#region src/ui/KeywordTreePanel.tsx
const NOTICE_MS = 6e3;
function KeywordTreePanel() {
	const revision = kw((s) => s.revision);
	const expanded = kw((s) => s.expanded);
	const filterKeys = kw((s) => s.filterKeys);
	const editingKey = kw((s) => s.editingKey);
	const targets = useTargetPhotos();
	const counts = useKeywordCounts();
	const [notice, setNotice] = React.useState(null);
	const [search, setSearch] = React.useState("");
	const [renamingKey, setRenamingKey] = React.useState(null);
	const [armDelete, setArmDelete] = React.useState(false);
	const { menu, openMenu } = useMenu();
	const fileRef = React.useRef(null);
	React.useEffect(() => {
		if (!notice) return;
		const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
		return () => window.clearTimeout(t);
	}, [notice]);
	const say = React.useCallback((text) => setNotice({
		tone: "info",
		text
	}), []);
	const { rows, deepCounts } = React.useMemo(() => {
		const roots = kw.getState().roots;
		const deep = /* @__PURE__ */ new Map();
		const sumDeep = (node) => {
			let total = counts.get(keyOf(node.name))?.count ?? 0;
			for (const child of node.children) total += sumDeep(child);
			deep.set(keyOf(node.name), total);
			return total;
		};
		for (const root of roots) sumDeep(root);
		const needle = search.trim().toLowerCase();
		let visibleKeys = null;
		if (needle) {
			visibleKeys = /* @__PURE__ */ new Set();
			const walk = (nodes, ancestors) => {
				for (const node of nodes) {
					const key = keyOf(node.name);
					if (node.name.toLowerCase().includes(needle) || node.synonyms.some((s) => s.toLowerCase().includes(needle))) {
						visibleKeys.add(key);
						for (const a of ancestors) visibleKeys.add(a);
					}
					walk(node.children, [...ancestors, key]);
				}
			};
			walk(roots, []);
		}
		const out = [];
		const walkVisible = (nodes, depth, path) => {
			for (const node of nodes) {
				const key = keyOf(node.name);
				if (visibleKeys && !visibleKeys.has(key)) continue;
				const nodePath = [...path, node.name];
				const isExpanded = visibleKeys ? true : expanded.includes(key);
				out.push({
					data: {
						node,
						key,
						depth,
						path: nodePath
					},
					hasChildren: node.children.length > 0,
					expanded: isExpanded
				});
				if (node.children.length > 0 && isExpanded) walkVisible(node.children, depth + 1, nodePath);
			}
		};
		walkVisible(roots, 0, []);
		return {
			rows: out,
			deepCounts: deep
		};
	}, [
		revision,
		expanded,
		search,
		counts
	]);
	const treeIsEmpty = kw.getState().roots.length === 0;
	const unfiled = React.useMemo(() => {
		const index = indexTree(kw.getState().roots);
		return [...counts.entries()].filter(([key]) => !index.has(key)).sort((a, b) => b[1].count - a[1].count).map(([key, { display, count }]) => ({
			key,
			display,
			count
		}));
	}, [revision, counts]);
	const menuFor = (data, isUnfiled) => {
		const name = data.node.name;
		const haveTargets = targetIds().length > 0;
		if (isUnfiled) return [
			{
				label: "Add to keyword tree",
				onClick: () => {
					addRootKeyword(name);
					say(`Added "${name}" to the tree`);
				}
			},
			{
				label: "Filter by this",
				onClick: () => toggleFilterKey(data.key, false)
			},
			{
				label: "Remove from selection",
				disabled: !haveTargets,
				onClick: () => void removeFromTargets(data.key).then(() => say(`Removed "${name}"`))
			}
		];
		return [
			{
				label: "New child keyword",
				onClick: () => setRenamingKey(createChild(data.key))
			},
			{
				label: "Rename",
				onClick: () => setRenamingKey(data.key)
			},
			{
				label: "Edit details…",
				onClick: () => {
					setArmDelete(false);
					setEditing(data.key);
				}
			},
			{
				label: "Apply to selection",
				disabled: !haveTargets,
				onClick: () => void applyPaths([[name]]).then(() => say(`Applied "${name}"`))
			},
			{
				label: "Remove from selection",
				disabled: !haveTargets,
				onClick: () => void removeFromTargets(data.key).then(() => say(`Removed "${name}"`))
			},
			{
				label: "Filter by this",
				onClick: () => toggleFilterKey(data.key, false)
			},
			{
				label: "Delete…",
				danger: true,
				onClick: () => {
					setArmDelete(true);
					setEditing(data.key);
				}
			}
		];
	};
	const onImportFile = async (file) => {
		const { stats, parsed } = importLrText(await file.text());
		if (parsed.keywordCount === 0) {
			setNotice({
				tone: "warn",
				text: parsed.errors[0] ?? "No keywords found — is this a Lightroom keyword list?"
			});
			return;
		}
		const skipped = parsed.errors.length ? ` — ${parsed.errors.length} line(s) skipped` : "";
		setNotice({
			tone: parsed.errors.length ? "warn" : "info",
			text: `Imported ${stats.added} new, merged ${stats.merged} existing${skipped}`
		});
	};
	const onExport = () => {
		const text = exportLrText();
		if (!text) {
			setNotice({
				tone: "warn",
				text: "The keyword tree is empty"
			});
			return;
		}
		const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = "safelight-keywords.txt";
		a.click();
		URL.revokeObjectURL(url);
	};
	return /* @__PURE__ */ React.createElement("div", {
		style: { padding: 10 },
		onDragOver: (e) => {
			if (e.dataTransfer.types.includes("application/x-hk-keyword")) {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
			}
		},
		onDrop: (e) => {
			const dragged = e.dataTransfer.getData(DND_KEYWORD);
			if (dragged) {
				e.preventDefault();
				moveNodeAction(dragged, null);
			}
		}
	}, /* @__PURE__ */ React.createElement(ui.Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(EntryField, { onNotice: setNotice }), notice && /* @__PURE__ */ React.createElement("div", { style: {
		borderLeft: `2px solid ${notice.tone === "warn" ? ui.tokens.rating : ui.tokens.accent}`,
		paddingLeft: 8,
		fontSize: 11,
		lineHeight: 1.5,
		color: ui.tokens.textSecondary
	} }, notice.text), filterKeys.length > 0 && /* @__PURE__ */ React.createElement(ui.Row, {
		gap: 6,
		align: "center"
	}, /* @__PURE__ */ React.createElement("span", { style: {
		fontSize: 11,
		color: ui.tokens.textSecondary
	} }, "Filtering by ", filterKeys.length, " keyword", filterKeys.length > 1 ? "s" : ""), /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		onClick: clearFilter
	}, "Clear")), !treeIsEmpty && /* @__PURE__ */ React.createElement(ui.TextInput, {
		value: search,
		onChange: setSearch,
		placeholder: "Search keywords…"
	}), treeIsEmpty && unfiled.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: {
		fontSize: 11,
		lineHeight: 1.5,
		color: ui.tokens.textMuted
	} }, "No keywords yet. Type above to tag the selected photos — use", " ", /* @__PURE__ */ React.createElement("span", { style: { fontFamily: ui.tokens.fontMono } }, "Nature > Birds > Eagle"), " to create a hierarchy — or import a Lightroom keyword list below.") : /* @__PURE__ */ React.createElement("div", null, rows.map(({ data, hasChildren, expanded: isExpanded }) => /* @__PURE__ */ React.createElement(React.Fragment, { key: data.key }, /* @__PURE__ */ React.createElement(TreeRow, {
		data,
		hasChildren,
		expanded: isExpanded,
		checkState: checkStateFor(data.key, targets),
		count: counts.get(data.key)?.count ?? 0,
		deepCount: deepCounts.get(data.key) ?? 0,
		filterActive: filterKeys.includes(data.key),
		renaming: renamingKey === data.key,
		onRenameStart: () => setRenamingKey(data.key),
		onRenameEnd: () => setRenamingKey(null),
		onOpenMenu: (e, d) => openMenu(e, menuFor(d, false)),
		onNotice: say
	}), editingKey === data.key && /* @__PURE__ */ React.createElement(NodeEditor, {
		data,
		armDelete,
		onNotice: say,
		onClose: () => {
			setEditing(null);
			setArmDelete(false);
		}
	}))), rows.length === 0 && !treeIsEmpty && /* @__PURE__ */ React.createElement("div", { style: {
		fontSize: 11,
		color: ui.tokens.textMuted,
		padding: "4px 0"
	} }, "No keywords match \"", search, "\"")), unfiled.length > 0 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", {
		title: "Keywords on photos in this catalog that aren't in your tree yet",
		style: {
			fontSize: 10,
			textTransform: "uppercase",
			letterSpacing: "0.05em",
			color: ui.tokens.textMuted,
			margin: "4px 0 2px"
		}
	}, "Unfiled"), unfiled.map(({ key, display, count }) => /* @__PURE__ */ React.createElement(TreeRow, {
		key,
		data: {
			node: createNode(display),
			key,
			depth: 0,
			path: [display]
		},
		hasChildren: false,
		expanded: false,
		checkState: checkStateFor(key, targets),
		count,
		deepCount: count,
		filterActive: filterKeys.includes(key),
		renaming: false,
		unfiled: true,
		onRenameStart: () => {},
		onRenameEnd: () => {},
		onOpenMenu: (e, d) => openMenu(e, menuFor(d, true)),
		onNotice: say
	}))), /* @__PURE__ */ React.createElement(ui.Row, {
		gap: 6,
		justify: "space-between"
	}, /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		title: "Create a top-level keyword",
		onClick: () => setRenamingKey(createChild(null))
	}, "+ New"), /* @__PURE__ */ React.createElement(ui.Row, { gap: 6 }, /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		title: "Import a Lightroom keyword list (.txt)",
		onClick: () => fileRef.current?.click()
	}, "Import…"), /* @__PURE__ */ React.createElement(ui.Button, {
		variant: "ghost",
		size: "sm",
		title: "Export the tree as a Lightroom keyword list",
		onClick: onExport
	}, "Export")))), /* @__PURE__ */ React.createElement("input", {
		ref: fileRef,
		type: "file",
		accept: ".txt,text/plain",
		style: { display: "none" },
		onChange: (e) => {
			const file = e.currentTarget.files?.[0];
			e.currentTarget.value = "";
			if (file) onImportFile(file);
		}
	}), menu);
}
//#endregion
//#region src/index.tsx
const ID = "com.safelight.hierarchical-keywording";
const PANEL_ID = `${ID}.panel`;
const FILTER_ID = `${ID}.filter`;
function activate(api) {
	initRuntime(api);
	initKeywordStore();
	api.registerPanel({
		id: PANEL_ID,
		title: "Keyword Tree",
		component: KeywordTreePanel,
		defaultDock: {
			module: "library",
			direction: "left",
			order: 3,
			width: 260
		}
	});
	const syncFilter = () => {
		const predicate = currentFilterPredicate();
		api.registerGridFilter({
			id: FILTER_ID,
			test: predicate ?? (() => true),
			onClear: clearFilter
		});
	};
	syncFilter();
	let hadFilter = false;
	kw.subscribe((s, prev) => {
		const has = s.filterKeys.length > 0;
		if (s.filterKeys !== prev.filterKeys || has && s.revision !== prev.revision || has !== hadFilter) {
			hadFilter = has;
			syncFilter();
		}
	});
	const openPanelAndFocus = (ids) => {
		if (ids && ids.length > 0) api.stores.useCatalogStore.setState({
			selectedIds: new Set(ids),
			activePhotoId: ids[0]
		});
		if (!isPanelMounted()) api.dock.togglePanel(PANEL_ID);
		requestEntryFocus();
	};
	api.registerGridMenuItem({
		id: `${ID}.add`,
		order: 12,
		label: (ids) => ids.length > 1 ? `Add keywords… (${ids.length})` : "Add keywords…",
		onClick: (ids) => openPanelAndFocus(ids)
	});
	api.registerKeybinding({
		id: `${ID}.focus`,
		label: "Focus keyword tree entry",
		category: "Library",
		defaultCombo: "Ctrl+K",
		handler: () => openPanelAndFocus()
	});
	api.registerCatalogHooks({
		id: `${ID}.sidecar-learn`,
		async onPhotoImport({ photo, dir, fileName }) {
			const sidecar = await readSidecarKeywords(dir, fileName);
			if (!sidecar) return;
			learnPaths(sidecar.paths);
			const merged = [...photo.keywords];
			const have = new Set(merged.map(keyOf));
			const incoming = [...sidecar.flat, ...sidecar.paths.map((p) => p[p.length - 1])];
			for (const name of incoming) if (!have.has(keyOf(name))) {
				merged.push(name);
				have.add(keyOf(name));
			}
			if (merged.length !== photo.keywords.length) return { keywords: merged };
		}
	});
	api.registerSettings({
		title: "Hierarchical Keywording",
		fields: [{
			key: SETTING_TAG_ANCESTORS,
			label: "Also tag ancestor keywords on photos",
			hint: "Applying \"Eagle\" under Animals > Birds writes all three keywords onto the photo. Keeps full hierarchy visible to apps that only read flat keywords; off matches Lightroom, which implies parents instead.",
			type: "boolean",
			default: false
		}]
	});
}
function deactivate() {
	flushPersist();
}
//#endregion
export { activate, deactivate };
