// Run: node --experimental-strip-types src/model/paths.test.ts
import assert from "node:assert";
import { parseEntry } from "./paths.ts";

{
  const p = parseEntry("Animals > Birds > Eagle, Sunset");
  assert.deepEqual(p.paths, [["Animals", "Birds", "Eagle"], ["Sunset"]]);
  assert.deepEqual(p.errors, []);
}
{
  // XMP-style pipes, sloppy whitespace, empty segments and terms.
  const p = parseEntry("  Animals|Birds ,  , Places >  > Alaska ,");
  assert.deepEqual(p.paths, [["Animals", "Birds"], ["Places", "Alaska"]]);
  assert.deepEqual(p.errors, []);
}
{
  const p = parseEntry("Ok, Bad{brace}, Also Ok");
  assert.deepEqual(p.paths, [["Ok"], ["Also Ok"]]);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /Bad\{brace\}/);
}
{
  assert.deepEqual(parseEntry("").paths, []);
  assert.deepEqual(parseEntry("  ,  , ").paths, []);
  // Internal whitespace collapses; names keep their case.
  assert.deepEqual(parseEntry("New   York").paths, [["New York"]]);
}

console.log("OK paths.test.ts");
