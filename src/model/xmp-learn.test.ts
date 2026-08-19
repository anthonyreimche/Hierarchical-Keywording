// Run: node --experimental-strip-types src/model/xmp-learn.test.ts
import assert from "node:assert";
import { extractKeywordData, sidecarNameFor } from "./xmp-learn.ts";

// ── sidecar naming (Adobe convention) ────────────────────────────────────────
{
  assert.equal(sidecarNameFor("DSC_0012.NEF"), "DSC_0012.xmp");
  assert.equal(sidecarNameFor("DSC_0012.dng"), "DSC_0012.xmp");
  assert.equal(sidecarNameFor("DSC_0012.JPG"), "DSC_0012_jpg.xmp");
  assert.equal(sidecarNameFor("photo.tiff"), "photo_tiff.xmp");
  assert.equal(sidecarNameFor("noext"), "noext.xmp");
}

// ── extraction ───────────────────────────────────────────────────────────────
const XMP = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:lr="http://ns.adobe.com/lightroom/1.0/" rdf:about="">
      <dc:subject>
        <rdf:Bag>
          <rdf:li>Eagle</rdf:li>
          <rdf:li>Alaska</rdf:li>
          <rdf:li>Fish &amp; Chips</rdf:li>
        </rdf:Bag>
      </dc:subject>
      <lr:hierarchicalSubject>
        <rdf:Bag>
          <rdf:li>Animals|Birds|Eagle</rdf:li>
          <rdf:li>Places|Alaska</rdf:li>
          <rdf:li> Loose </rdf:li>
        </rdf:Bag>
      </lr:hierarchicalSubject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

{
  const data = extractKeywordData(XMP);
  assert.deepEqual(data.flat, ["Eagle", "Alaska", "Fish & Chips"]);
  assert.deepEqual(data.paths, [["Animals", "Birds", "Eagle"], ["Places", "Alaska"], ["Loose"]]);
}

// rdf:Seq variant (some writers) and attribute-carrying li tags.
{
  const seq = `<dc:subject><rdf:Seq><rdf:li xml:lang="x-default">One</rdf:li></rdf:Seq></dc:subject>`;
  assert.deepEqual(extractKeywordData(seq).flat, ["One"]);
}

// No keyword blocks → empty result.
{
  const data = extractKeywordData("<x:xmpmeta></x:xmpmeta>");
  assert.deepEqual(data.flat, []);
  assert.deepEqual(data.paths, []);
}

console.log("OK xmp-learn.test.ts");
