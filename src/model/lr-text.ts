// Lightroom keyword-list interchange (.txt). The format Lightroom Classic
// exports and imports — and the de-facto exchange format for purchased
// controlled vocabularies: one keyword per line, hierarchy by leading tabs,
// "[Name]" marks a keyword excluded from export, "{name}" lines are synonyms
// of the keyword one level up. We tolerate CRLF and 4-space indentation on
// parse; we emit tabs. Flags with no .txt syntax (export parents / export
// synonyms) do not round-trip — Lightroom's own exports drop them too.

import { nameProblem, normalizeKeywordName } from "./names.ts";
import { createNode, type KeywordNode } from "./tree.ts";

export interface ParsedLrText {
  roots: KeywordNode[];
  keywordCount: number;
  synonymCount: number;
  errors: string[];
}

export function parseLrText(text: string): ParsedLrText {
  const roots: KeywordNode[] = [];
  const errors: string[] = [];
  let keywordCount = 0;
  let synonymCount = 0;

  // stack[d] = the most recent keyword node at depth d
  const stack: KeywordNode[] = [];

  const lines = text.split(/\r\n?|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    const tabs = /^\t*/.exec(line)![0].length;
    const spaces = tabs === 0 ? /^ */.exec(line)![0].length : 0;
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

  return { roots, keywordCount, synonymCount, errors };
}

export function serializeLrText(roots: KeywordNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: KeywordNode[], depth: number) => {
    const indent = "\t".repeat(depth);
    for (const node of nodes) {
      lines.push(indent + (node.includeOnExport ? node.name : `[${node.name}]`));
      for (const syn of node.synonyms) lines.push(`${indent}\t{${syn}}`);
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return lines.join("\n") + (lines.length ? "\n" : "");
}
