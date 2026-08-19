// Keyword name rules shared by the tree, the entry field, and the .txt parser.
// Names are display-cased; identity is the case-folded key. The forbidden set
// covers every character that carries syntax elsewhere: "|" (XMP path
// separator), ">" and "," (entry-field separators), "[]{}"  (Lightroom .txt
// markers), and tabs (its indentation).

const FORBIDDEN = /[|>,[\]{}\t]/;

/** Trim and collapse internal whitespace runs to single spaces. */
export function normalizeKeywordName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Case-folded identity key for a (normalized) keyword name. */
export function keyOf(name: string): string {
  return name.toLowerCase();
}

/** null when the (already normalized) name is usable, else the reason. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return "empty name";
  const hit = FORBIDDEN.exec(name);
  if (hit) return `"${hit[0]}" is not allowed in keyword names`;
  return null;
}
