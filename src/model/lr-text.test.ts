// Run: node --experimental-strip-types src/model/lr-text.test.ts
import assert from "node:assert";
import { parseLrText, serializeLrText } from "./lr-text.ts";
import { indexTree } from "./tree.ts";

// A representative Lightroom export: tabs, synonyms in braces one level under
// their keyword, a bracketed don't-export keyword, CRLF endings, blank lines.
const SAMPLE = [
  "Animals",
  "\tBirds",
  "\t\t{avians}",
  "\t\tEagle",
  "\t\t\t{bird of prey}",
  "\t\t\t{raptor}",
  "\t\tHawk",
  "\t[Pending Review]",
  "",
  "Places",
  "\tAlaska",
].join("\r\n");

{
  const parsed = parseLrText(SAMPLE);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.keywordCount, 7);
  assert.equal(parsed.synonymCount, 3);

  const idx = indexTree(parsed.roots);
  assert.deepEqual(idx.get("eagle")?.path, ["Animals", "Birds", "Eagle"]);
  assert.deepEqual(idx.get("eagle")?.node.synonyms, ["bird of prey", "raptor"]);
  assert.deepEqual(idx.get("birds")?.node.synonyms, ["avians"]);
  assert.equal(idx.get("pending review")?.node.includeOnExport, false);
  assert.deepEqual(idx.get("alaska")?.path, ["Places", "Alaska"]);
}

// Round-trip: serialize → parse reproduces structure, synonyms, and flags.
{
  const parsed = parseLrText(SAMPLE);
  const text = serializeLrText(parsed.roots);
  const again = parseLrText(text);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.roots, parsed.roots);
  assert.match(text, /\[Pending Review\]/);
  assert.match(text, /\t\t\t\{raptor\}/);
}

// 4-space indentation fallback (hand-edited lists).
{
  const parsed = parseLrText("Animals\n    Birds\n        Eagle\n");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(indexTree(parsed.roots).get("eagle")?.path, ["Animals", "Birds", "Eagle"]);
}

// Error reporting: level skips, orphan synonyms, invalid names — with line numbers.
{
  const parsed = parseLrText("A\n\t\t\tTooDeep\n{orphan}\nBad|Pipe\n");
  assert.equal(parsed.keywordCount, 1);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0], /line 2/);
  assert.match(parsed.errors[1], /line 3/);
  assert.match(parsed.errors[2], /line 4/);
}

// Empty and whitespace-only input.
{
  assert.equal(parseLrText("").keywordCount, 0);
  assert.equal(serializeLrText([]), "");
}

console.log("OK lr-text.test.ts");
