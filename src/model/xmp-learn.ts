// Hierarchy learning from XMP sidecars written by Lightroom, darktable, and
// friends: lr:hierarchicalSubject carries full "A|B|C" paths, dc:subject the
// flat keywords. Read-only — writing sidecars stays with the XMP Tools
// extension so the file ever has one writer.

export interface SidecarKeywords {
  /** dc:subject entries (flat keyword names). */
  flat: string[];
  /** lr:hierarchicalSubject entries split into path segments. */
  paths: string[][];
}

const RAW_EXT =
  /^(nef|cr2|cr3|crw|dng|arw|orf|raf|rw2|pef|srw|3fr|dcr|erf|kdc|mos|raw|nrw)$/i;

/** Adobe sidecar naming: DSC_0012.NEF → DSC_0012.xmp; DSC_0012.JPG →
 *  DSC_0012_jpg.xmp (so RAW+JPEG pairs keep distinct sidecars). */
export function sidecarNameFor(imageFilename: string): string {
  const dot = imageFilename.lastIndexOf(".");
  if (dot === -1) return `${imageFilename}.xmp`;
  const base = imageFilename.slice(0, dot);
  const ext = imageFilename.slice(dot + 1);
  return RAW_EXT.test(ext) ? `${base}.xmp` : `${base}_${ext.toLowerCase()}.xmp`;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, "&");
}

function bagItems(xml: string, element: string): string[] {
  const bag = new RegExp(
    `<${element}>\\s*<rdf:(?:Bag|Seq)>([\\s\\S]*?)</rdf:(?:Bag|Seq)>\\s*</${element}>`,
  ).exec(xml);
  if (!bag) return [];
  const items: string[] = [];
  const li = /<rdf:li[^>]*>([^<]*)<\/rdf:li>/g;
  let m: RegExpExecArray | null;
  while ((m = li.exec(bag[1])) !== null) {
    const value = unescapeXml(m[1]).trim();
    if (value.length > 0) items.push(value);
  }
  return items;
}

export function extractKeywordData(xml: string): SidecarKeywords {
  const flat = bagItems(xml, "dc:subject");
  const paths = bagItems(xml, "lr:hierarchicalSubject")
    .map((entry) =>
      entry
        .split("|")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .filter((path) => path.length > 0);
  return { flat, paths };
}

/** Read and extract the sidecar for one image; null when there is none. */
export async function readSidecarKeywords(
  dir: FileSystemDirectoryHandle,
  imageFilename: string,
): Promise<SidecarKeywords | null> {
  try {
    const handle = await dir.getFileHandle(sidecarNameFor(imageFilename));
    const file = await handle.getFile();
    const data = extractKeywordData(await file.text());
    return data.flat.length || data.paths.length ? data : null;
  } catch {
    return null;
  }
}
