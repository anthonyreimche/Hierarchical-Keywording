// Entry-field parsing: comma-separated terms, each optionally a hierarchy path
// ("Animals > Birds > Eagle" or the XMP spelling "Animals|Birds|Eagle").

import { nameProblem, normalizeKeywordName } from "./names.ts";

export interface ParsedEntry {
  paths: string[][];
  errors: string[];
}

export function parseEntry(raw: string): ParsedEntry {
  const paths: string[][] = [];
  const errors: string[] = [];
  for (const term of raw.split(",")) {
    if (term.trim().length === 0) continue;
    const segments = term
      .split(/[>|]/)
      .map(normalizeKeywordName)
      .filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const bad = segments.map(nameProblem).find((p) => p !== null);
    if (bad) {
      errors.push(`"${term.trim()}": ${bad}`);
      continue;
    }
    paths.push(segments);
  }
  return { paths, errors };
}
