// The keyword entry: comma-separated terms, "Parent > Child" (or "A|B") path
// creation, autocomplete over names and synonyms with each match's full path
// shown, and one-click re-apply of recent keywords.

import type { ReactElement } from "react";
import { React, ui } from "../runtime";
import { keyOf } from "../model/names.ts";
import { parseEntry } from "../model/paths.ts";
import { indexTree } from "../model/tree.ts";
import { applyPaths, kw } from "../store";
import { useEntryFocus, useKeywordCounts, useTargetPhotos } from "./hooks.ts";

export interface Notice {
  tone: "info" | "warn";
  text: string;
}

interface Suggestion {
  /** What gets inserted into the entry (the keyword's display name). */
  insert: string;
  /** Muted context: full path, or the matched synonym. */
  context: string;
}

const MAX_SUGGESTIONS = 8;

export function EntryField({ onNotice }: { onNotice(notice: Notice): void }): ReactElement {
  const revision = kw((s) => s.revision);
  const recent = kw((s) => s.recent);
  const targets = useTargetPhotos();
  const counts = useKeywordCounts();

  const [value, setValue] = React.useState("");
  const [openList, setOpenList] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement | null>(null);

  useEntryFocus(
    React.useCallback(() => {
      boxRef.current?.querySelector("input")?.focus();
    }, []),
  );

  // Searchable vocabulary: every tree keyword (by name and by synonym) plus
  // unfiled keywords seen on photos.
  const vocabulary = React.useMemo(() => {
    void revision;
    const index = indexTree(kw.getState().roots);
    const entries: { match: string; insert: string; context: string }[] = [];
    for (const { node, path } of index.values()) {
      const pathLabel = path.join(" > ");
      entries.push({ match: node.name, insert: node.name, context: pathLabel });
      for (const syn of node.synonyms) {
        entries.push({ match: syn, insert: node.name, context: `synonym of ${pathLabel}` });
      }
    }
    for (const [key, { display }] of counts) {
      if (!index.has(key)) entries.push({ match: display, insert: display, context: "unfiled" });
    }
    return entries;
  }, [revision, counts]);

  const term = value.slice(value.lastIndexOf(",") + 1).trim();
  const suggestions = React.useMemo<Suggestion[]>(() => {
    if (term.length === 0) return [];
    const needle = term.toLowerCase();
    const starts: Suggestion[] = [];
    const contains: Suggestion[] = [];
    const seen = new Set<string>();
    for (const { match, insert, context } of vocabulary) {
      const hay = match.toLowerCase();
      if (hay === needle || seen.has(keyOf(insert))) continue;
      if (hay.startsWith(needle)) starts.push({ insert, context });
      else if (hay.includes(needle)) contains.push({ insert, context });
      else continue;
      seen.add(keyOf(insert));
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [term, vocabulary]);

  React.useEffect(() => setHi(0), [term]);

  const acceptSuggestion = (s: Suggestion): string => {
    const head = value.slice(0, value.lastIndexOf(",") + 1);
    const next = head.length ? `${head} ${s.insert}` : s.insert;
    setValue(next);
    setOpenList(false);
    return next;
  };

  const apply = async (raw: string) => {
    const { paths, errors } = parseEntry(raw);
    if (paths.length === 0 && errors.length === 0) return;
    const result = await applyPaths(paths);
    const problems = [...errors, ...result.errors];
    if (problems.length > 0) {
      onNotice({ tone: "warn", text: problems[0] });
      return;
    }
    setValue("");
    setOpenList(false);
    if (result.applied.length > 0) {
      onNotice({
        tone: "info",
        text:
          targets.length > 1
            ? `Applied ${result.applied.length} keyword${result.applied.length > 1 ? "s" : ""} to ${targets.length} photos`
            : `Applied ${result.applied.join(", ")}`,
      });
    } else if (result.created.length > 0) {
      onNotice({ tone: "info", text: `Created ${result.created.join(", ")} (no photo selected)` });
    }
  };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <ui.TextInput
        value={value}
        onChange={(v) => {
          setValue(v);
          setOpenList(true);
        }}
        placeholder={targets.length > 1 ? `Add keywords to ${targets.length} photos…` : "Add keywords…"}
        onKeyDown={(e) => {
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
            void apply(raw);
          } else if (e.key === "Escape" && openList) {
            e.stopPropagation();
            setOpenList(false);
          }
        }}
        onBlur={() => window.setTimeout(() => setOpenList(false), 120)}
      />
      {openList && suggestions.length > 0 && (
        <div
          style={{
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
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
          }}
        >
          {suggestions.map((s, i) => (
            <div
              key={`${s.insert}:${s.context}`}
              onMouseDown={(e) => {
                e.preventDefault();
                void apply(acceptSuggestion(s));
              }}
              onMouseEnter={() => setHi(i)}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                padding: "4px 8px",
                fontSize: 12,
                cursor: "pointer",
                background: i === hi ? ui.tokens.surface2 : "transparent",
              }}
            >
              <span style={{ color: ui.tokens.textPrimary }}>{s.insert}</span>
              <span
                style={{
                  color: ui.tokens.textMuted,
                  fontSize: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.context}
              </span>
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <ui.Row gap={4} wrap style={{ marginTop: 6 }}>
          {recent.map((name) => (
            <button
              key={name}
              title={`Apply "${name}"`}
              onClick={() => void applyPaths([[name]])}
              style={{
                border: `1px solid ${ui.tokens.borderSubtle}`,
                background: ui.tokens.surface2,
                color: ui.tokens.textSecondary,
                borderRadius: 10,
                fontSize: 10,
                lineHeight: "16px",
                padding: "0 7px",
                cursor: "pointer",
              }}
            >
              {name}
            </button>
          ))}
        </ui.Row>
      )}
    </div>
  );
}
