// Run: node --experimental-strip-types src/model/tree.test.ts
import assert from "node:assert";
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
} from "./tree.ts";

function names(nodes: KeywordNode[]): string[] {
  return nodes.map((n) => n.name);
}

// ── ensurePath ───────────────────────────────────────────────────────────────
{
  const roots: KeywordNode[] = [];
  const a = ensurePath(roots, ["Animals", "Birds", "Eagle"]);
  assert.equal(a.leaf?.name, "Eagle");
  assert.deepEqual(a.createdNames, ["Animals", "Birds", "Eagle"]);
  assert.deepEqual(names(roots), ["Animals"]);
  assert.deepEqual(names(roots[0].children), ["Birds"]);

  // Existing segment is reused, only the tail is created.
  const b = ensurePath(roots, ["Animals", "Birds", "Hawk"]);
  assert.deepEqual(b.createdNames, ["Hawk"]);
  assert.deepEqual(names(roots[0].children[0].children), ["Eagle", "Hawk"]);

  // Unique-name policy: an existing name anywhere wins over the typed position.
  const c = ensurePath(roots, ["Wildlife", "Eagle"]);
  assert.deepEqual(c.createdNames, ["Wildlife"]);
  assert.equal(c.leaf?.name, "Eagle");
  const idx = indexTree(roots);
  assert.deepEqual(idx.get("eagle")?.path, ["Animals", "Birds", "Eagle"]);

  // Case-insensitive match reuses the node without duplicating.
  const d = ensurePath(roots, ["ANIMALS"]);
  assert.deepEqual(d.createdNames, []);
  assert.equal(d.leaf?.name, "Animals");

  // Invalid segment reports and creates nothing further.
  const e = ensurePath(roots, ["Ok", "Bad{name}"]);
  assert.ok(e.problem);
  assert.equal(e.leaf, null);
}

// ── mergeForest ──────────────────────────────────────────────────────────────
{
  const roots: KeywordNode[] = [];
  ensurePath(roots, ["Animals", "Birds"]);

  const incoming = [createNode("Animals")];
  incoming[0].children.push(createNode("Mammals"));
  const birds = createNode("Birds", { synonyms: ["avians"], includeOnExport: false });
  birds.children.push(createNode("Eagle"));
  incoming.push(birds);

  const stats = mergeForest(roots, incoming);
  assert.equal(stats.added, 2); // Mammals, Eagle
  assert.equal(stats.merged, 2); // Animals, Birds
  const idx = indexTree(roots);
  assert.deepEqual(idx.get("eagle")?.path, ["Animals", "Birds", "Eagle"]);
  assert.deepEqual(idx.get("birds")?.node.synonyms, ["avians"]);
  assert.equal(idx.get("birds")?.node.includeOnExport, false); // AND: don't-export wins
  assert.equal(idx.get("mammals")?.parent?.name, "Animals");

  // Invalid node name: skipped, but its children survive at the same level.
  const bad = createNode("Bro[ken]");
  bad.children.push(createNode("Survivor"));
  mergeForest(roots, [bad]);
  const idx2 = indexTree(roots);
  assert.ok(idx2.get("survivor"));
  assert.equal(idx2.get("survivor")?.parent, null);
  assert.equal(idx2.get("bro[ken]"), undefined);

  // Cloning: mutating the incoming forest never reaches the tree.
  const alias = createNode("Aliased", { synonyms: ["syn"] });
  mergeForest(roots, [alias]);
  alias.synonyms.push("mutated");
  alias.name = "Mutated";
  const idx3 = indexTree(roots);
  assert.deepEqual(idx3.get("aliased")?.node.synonyms, ["syn"]);
}

// ── renameNode ───────────────────────────────────────────────────────────────
{
  const roots: KeywordNode[] = [];
  ensurePath(roots, ["Animals", "Birds", "Eagle"]);
  ensurePath(roots, ["Trips", "Alaska"]);

  assert.deepEqual(renameNode(roots, "eagle", "Bald Eagle"), { kind: "renamed" });
  assert.ok(indexTree(roots).get("bald eagle"));

  // Case-only rename keeps identity.
  assert.deepEqual(renameNode(roots, "alaska", "ALASKA"), { kind: "renamed" });
  assert.equal(indexTree(roots).get("alaska")?.node.name, "ALASKA");

  // Rename onto an existing name merges the subtree into the incumbent.
  ensurePath(roots, ["Birds", "Hawk"]); // Hawk under existing Birds
  const merged = renameNode(roots, "trips", "Birds");
  assert.deepEqual(merged, { kind: "merged", into: "Birds" });
  const idx = indexTree(roots);
  assert.equal(idx.get("trips"), undefined);
  assert.deepEqual(idx.get("alaska")?.path, ["Animals", "Birds", "ALASKA"]);

  assert.deepEqual(renameNode(roots, "ghost", "X"), { kind: "missing" });
  assert.equal(renameNode(roots, "birds", "a>b").kind, "invalid");
}

// ── moveNode ─────────────────────────────────────────────────────────────────
{
  const roots: KeywordNode[] = [];
  ensurePath(roots, ["Animals", "Birds", "Eagle"]);
  ensurePath(roots, ["Places"]);

  assert.equal(moveNode(roots, "birds", "places"), true);
  let idx = indexTree(roots);
  assert.deepEqual(idx.get("eagle")?.path, ["Places", "Birds", "Eagle"]);

  // Cycle refused: a node can't move under its own descendant (or itself).
  assert.equal(moveNode(roots, "places", "eagle"), false);
  assert.equal(moveNode(roots, "places", "places"), false);

  // Move to top level.
  assert.equal(moveNode(roots, "eagle", null), true);
  idx = indexTree(roots);
  assert.deepEqual(idx.get("eagle")?.path, ["Eagle"]);

  // No-op move refused.
  assert.equal(moveNode(roots, "eagle", null), false);
}

// ── removeSubtree / collectNames / closureNameSet ────────────────────────────
{
  const roots: KeywordNode[] = [];
  ensurePath(roots, ["Animals", "Birds", "Eagle"]);
  ensurePath(roots, ["Animals", "Mammals"]);

  const idx = indexTree(roots);
  assert.deepEqual(collectNames(idx.get("animals")!.node), ["Animals", "Birds", "Eagle", "Mammals"]);

  const closure = closureNameSet(idx, ["birds", "not-in-tree"]);
  assert.deepEqual([...closure].sort(), ["birds", "eagle", "not-in-tree"]);

  const removed = removeSubtree(roots, "birds");
  assert.deepEqual(removed, ["Birds", "Eagle"]);
  assert.deepEqual(names(indexTree(roots).get("animals")!.node.children), ["Mammals"]);
  assert.deepEqual(removeSubtree(roots, "ghost"), []);
}

// ── sanitizeForest ───────────────────────────────────────────────────────────
{
  const raw = [
    {
      name: "  Animals  ",
      synonyms: ["fauna", 42, "fauna"],
      includeOnExport: false,
      children: [{ name: "Birds", children: [{ name: "Birds" }] }], // self-duplicate folds
    },
    { name: "" },
    "garbage",
    { name: "Animals", synonyms: ["wildlife"], children: [] }, // duplicate root merges
  ];
  const roots = sanitizeForest(raw);
  assert.deepEqual(names(roots), ["Animals"]);
  assert.deepEqual(roots[0].synonyms, ["fauna", "wildlife"]);
  assert.equal(roots[0].includeOnExport, false);
  assert.deepEqual(names(roots[0].children), ["Birds"]);
  assert.deepEqual(sanitizeForest(null), []);
  assert.deepEqual(sanitizeForest("nope"), []);
}

console.log("OK tree.test.ts");
