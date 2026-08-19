// The keyword hierarchy: plain JSON-able nodes plus the pure operations the
// store wraps. Invariant maintained by every operation here: keyword names are
// unique case-insensitively across the WHOLE tree, so a photo's flat keyword
// string maps to at most one node. Collisions arriving from imports merge into
// the incumbent node (it keeps its parent; synonyms union; each export flag
// ANDs, so a "don't export" on either side survives; children adopt).

import { keyOf, nameProblem, normalizeKeywordName } from "./names.ts";

export interface KeywordNode {
  name: string;
  synonyms: string[];
  includeOnExport: boolean;
  exportParents: boolean;
  exportSynonyms: boolean;
  children: KeywordNode[];
}

export interface KeywordTreeFile {
  version: 1;
  roots: KeywordNode[];
}

export interface NodeEntry {
  node: KeywordNode;
  parent: KeywordNode | null;
  /** Ancestor names root-first, ending with this node's own name. */
  path: string[];
}

export type TreeIndex = Map<string, NodeEntry>;

export function createNode(name: string, init?: Partial<Omit<KeywordNode, "name" | "children">>): KeywordNode {
  const synonyms: string[] = [];
  const seen = new Set<string>();
  for (const syn of init?.synonyms ?? []) {
    if (!seen.has(keyOf(syn))) {
      synonyms.push(syn);
      seen.add(keyOf(syn));
    }
  }
  return {
    name,
    synonyms,
    includeOnExport: init?.includeOnExport ?? true,
    exportParents: init?.exportParents ?? true,
    exportSynonyms: init?.exportSynonyms ?? true,
    children: [],
  };
}

export function indexTree(roots: KeywordNode[]): TreeIndex {
  const index: TreeIndex = new Map();
  const walk = (nodes: KeywordNode[], parent: KeywordNode | null, prefix: string[]) => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      index.set(keyOf(node.name), { node, parent, path });
      walk(node.children, node, path);
    }
  };
  walk(roots, null, []);
  return index;
}

function siblingsOf(roots: KeywordNode[], parent: KeywordNode | null): KeywordNode[] {
  return parent ? parent.children : roots;
}

function detach(roots: KeywordNode[], index: TreeIndex, key: string): NodeEntry | null {
  const entry = index.get(key);
  if (!entry) return null;
  const siblings = siblingsOf(roots, entry.parent);
  const at = siblings.indexOf(entry.node);
  if (at !== -1) siblings.splice(at, 1);
  return entry;
}

const byName = (a: KeywordNode, b: KeywordNode) => keyOf(a.name).localeCompare(keyOf(b.name));

/** Lightroom keeps keyword lists alphabetical; so do we, at every mutation. */
export function sortTree(roots: KeywordNode[]): void {
  roots.sort(byName);
  for (const node of roots) sortTree(node.children);
}

function mergeProps(into: KeywordNode, from: KeywordNode): void {
  const have = new Set(into.synonyms.map(keyOf));
  for (const syn of from.synonyms) {
    if (!have.has(keyOf(syn))) {
      into.synonyms.push(syn);
      have.add(keyOf(syn));
    }
  }
  into.includeOnExport = into.includeOnExport && from.includeOnExport;
  into.exportParents = into.exportParents && from.exportParents;
  into.exportSynonyms = into.exportSynonyms && from.exportSynonyms;
}

export interface MergeStats {
  added: number;
  merged: number;
}

/** Fold a forest of incoming nodes into the tree. An incoming name that exists
 *  anywhere keeps the incumbent node in place (unique-name policy) and merges
 *  props; its children then merge under that incumbent, not the incoming
 *  parent. Nodes are cloned in — the incoming forest is never aliased. */
export function mergeForest(
  roots: KeywordNode[],
  incoming: KeywordNode[],
  index: TreeIndex = indexTree(roots),
  under: KeywordNode | null = null,
): MergeStats {
  const stats: MergeStats = { added: 0, merged: 0 };
  const walk = (nodes: KeywordNode[], target: KeywordNode | null) => {
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
        index.set(keyOf(name), { node: clone, parent: target, path: [] });
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
export function ensurePath(
  roots: KeywordNode[],
  rawPath: string[],
): { leaf: KeywordNode | null; createdNames: string[]; problem: string | null } {
  const index = indexTree(roots);
  const createdNames: string[] = [];
  let cursor: KeywordNode | null = null;
  for (const raw of rawPath) {
    const name = normalizeKeywordName(raw);
    const problem = nameProblem(name);
    if (problem) return { leaf: null, createdNames, problem };
    const existing = index.get(keyOf(name));
    if (existing) {
      cursor = existing.node;
      continue;
    }
    const node = createNode(name);
    siblingsOf(roots, cursor).push(node);
    index.set(keyOf(name), { node, parent: cursor, path: [] });
    createdNames.push(name);
    cursor = node;
  }
  sortTree(roots);
  return { leaf: cursor, createdNames, problem: null };
}

export type RenameResult =
  | { kind: "renamed" }
  | { kind: "merged"; into: string }
  | { kind: "invalid"; reason: string }
  | { kind: "missing" };

/** Rename in place; renaming onto an existing name merges this node (and its
 *  subtree) into the incumbent. */
export function renameNode(roots: KeywordNode[], key: string, rawNewName: string): RenameResult {
  const newName = normalizeKeywordName(rawNewName);
  const problem = nameProblem(newName);
  if (problem) return { kind: "invalid", reason: problem };

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
  return { kind: "merged", into: incumbent.node.name };
}

/** Re-parent a node (null = top level). Refuses cycles and no-ops. */
export function moveNode(roots: KeywordNode[], key: string, newParentKey: string | null): boolean {
  const index = indexTree(roots);
  const entry = index.get(key);
  if (!entry) return false;

  let target: NodeEntry | null = null;
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
export function removeSubtree(roots: KeywordNode[], key: string): string[] {
  const index = indexTree(roots);
  const entry = detach(roots, index, key);
  return entry ? collectNames(entry.node) : [];
}

/** This node's name plus every descendant name, depth-first. */
export function collectNames(node: KeywordNode): string[] {
  const names: string[] = [];
  const walk = (n: KeywordNode) => {
    names.push(n.name);
    n.children.forEach(walk);
  };
  walk(node);
  return names;
}

/** Case-folded name set covering each key's node and all its descendants.
 *  Keys with no node (e.g. unfiled keywords) contribute themselves, so the
 *  same filter machinery covers tree and non-tree keywords alike. */
export function closureNameSet(index: TreeIndex, keys: Iterable<string>): Set<string> {
  const set = new Set<string>();
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
export function sanitizeForest(input: unknown): KeywordNode[] {
  const coerce = (value: unknown): KeywordNode | null => {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    const name = normalizeKeywordName(typeof raw.name === "string" ? raw.name : "");
    if (nameProblem(name)) return null;
    const synonyms = Array.isArray(raw.synonyms)
      ? raw.synonyms
          .filter((s): s is string => typeof s === "string")
          .map(normalizeKeywordName)
          .filter((s) => !nameProblem(s))
      : [];
    const node = createNode(name, {
      synonyms,
      includeOnExport: raw.includeOnExport !== false,
      exportParents: raw.exportParents !== false,
      exportSynonyms: raw.exportSynonyms !== false,
    });
    if (Array.isArray(raw.children)) {
      for (const child of raw.children) {
        const coerced = coerce(child);
        if (coerced) node.children.push(coerced);
      }
    }
    return node;
  };

  const forest: KeywordNode[] = [];
  if (Array.isArray(input)) {
    for (const value of input) {
      const node = coerce(value);
      if (node) forest.push(node);
    }
  }
  const roots: KeywordNode[] = [];
  mergeForest(roots, forest);
  return roots;
}
