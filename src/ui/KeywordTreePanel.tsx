// Panel root: entry field, keyword search, the tree (with per-row editors),
// unfiled keywords found on photos but not yet in the tree, and the
// import/export footer. Dropping a dragged keyword on the panel background
// re-parents it to the top level.

import type { ReactElement } from "react";
import { React, ui } from "../runtime";
import { keyOf } from "../model/names.ts";
import { createNode, indexTree, type KeywordNode } from "../model/tree.ts";
import {
  addRootKeyword,
  applyPaths,
  checkStateOf,
  clearFilter,
  createChild,
  exportLrText,
  importLrText,
  kw,
  moveNodeAction,
  removeFromTargets,
  setEditing,
  targetIds,
  targetKeyCounts,
  toggleFilterKey,
} from "../store";
import { EntryField, type Notice } from "./EntryField.tsx";
import { NodeEditor } from "./NodeEditor.tsx";
import { DND_KEYWORD, TreeRow, type RowData } from "./TreeRow.tsx";
import { useKeywordCounts, useTargetPhotos } from "./hooks.ts";
import { useMenu, type MenuItem } from "./menu.tsx";

const NOTICE_MS = 6000;

interface VisibleRow {
  data: RowData;
  hasChildren: boolean;
  expanded: boolean;
}

export function KeywordTreePanel(): ReactElement {
  const revision = kw((s) => s.revision);
  const expanded = kw((s) => s.expanded);
  const filterKeys = kw((s) => s.filterKeys);
  const editingKey = kw((s) => s.editingKey);
  const targets = useTargetPhotos();
  const counts = useKeywordCounts();
  const targetCounts = React.useMemo(() => targetKeyCounts(targets), [targets]);

  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [search, setSearch] = React.useState("");
  const [renamingKey, setRenamingKey] = React.useState<string | null>(null);
  const [armDelete, setArmDelete] = React.useState(false);
  const { menu, openMenu } = useMenu();
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  const say = React.useCallback((text: string) => setNotice({ tone: "info", text }), []);

  // Visible rows: the expansion-driven walk, or — while searching — every
  // match (name or synonym) with its ancestor chain forced open.
  const { rows, deepCounts } = React.useMemo(() => {
    const roots = kw.getState().roots;
    void revision;

    const deep = new Map<string, number>();
    const sumDeep = (node: KeywordNode): number => {
      let total = counts.get(keyOf(node.name))?.count ?? 0;
      for (const child of node.children) total += sumDeep(child);
      deep.set(keyOf(node.name), total);
      return total;
    };
    for (const root of roots) sumDeep(root);

    const needle = search.trim().toLowerCase();
    let visibleKeys: Set<string> | null = null;
    if (needle) {
      visibleKeys = new Set();
      const walk = (nodes: KeywordNode[], ancestors: string[]) => {
        for (const node of nodes) {
          const key = keyOf(node.name);
          const hit =
            node.name.toLowerCase().includes(needle) ||
            node.synonyms.some((s) => s.toLowerCase().includes(needle));
          if (hit) {
            visibleKeys!.add(key);
            for (const a of ancestors) visibleKeys!.add(a);
          }
          walk(node.children, [...ancestors, key]);
        }
      };
      walk(roots, []);
    }

    const out: VisibleRow[] = [];
    const walkVisible = (nodes: KeywordNode[], depth: number, path: string[]) => {
      for (const node of nodes) {
        const key = keyOf(node.name);
        if (visibleKeys && !visibleKeys.has(key)) continue;
        const nodePath = [...path, node.name];
        const isExpanded = visibleKeys ? true : expanded.includes(key);
        out.push({
          data: { node, key, depth, path: nodePath },
          hasChildren: node.children.length > 0,
          expanded: isExpanded,
        });
        if (node.children.length > 0 && isExpanded) walkVisible(node.children, depth + 1, nodePath);
      }
    };
    walkVisible(roots, 0, []);
    return { rows: out, deepCounts: deep };
  }, [revision, expanded, search, counts]);

  const treeIsEmpty = kw.getState().roots.length === 0;

  const unfiled = React.useMemo(() => {
    void revision;
    const index = indexTree(kw.getState().roots);
    return [...counts.entries()]
      .filter(([key]) => !index.has(key))
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, { display, count }]) => ({ key, display, count }));
  }, [revision, counts]);

  const menuFor = (data: RowData, isUnfiled: boolean): MenuItem[] => {
    const name = data.node.name;
    const haveTargets = targetIds().length > 0;
    if (isUnfiled) {
      return [
        { label: "Add to keyword tree", onClick: () => { addRootKeyword(name); say(`Added "${name}" to the tree`); } },
        { label: "Filter by this", onClick: () => toggleFilterKey(data.key, false) },
        {
          label: "Remove from selection",
          disabled: !haveTargets,
          onClick: () => void removeFromTargets(data.key).then(() => say(`Removed "${name}"`)),
        },
      ];
    }
    return [
      { label: "New child keyword", onClick: () => setRenamingKey(createChild(data.key)) },
      { label: "Rename", onClick: () => setRenamingKey(data.key) },
      { label: "Edit details…", onClick: () => { setArmDelete(false); setEditing(data.key); } },
      {
        label: "Apply to selection",
        disabled: !haveTargets,
        onClick: () => void applyPaths([[name]]).then(() => say(`Applied "${name}"`)),
      },
      {
        label: "Remove from selection",
        disabled: !haveTargets,
        onClick: () => void removeFromTargets(data.key).then(() => say(`Removed "${name}"`)),
      },
      { label: "Filter by this", onClick: () => toggleFilterKey(data.key, false) },
      { label: "Delete…", danger: true, onClick: () => { setArmDelete(true); setEditing(data.key); } },
    ];
  };

  const onImportFile = async (file: File) => {
    const { stats, parsed } = importLrText(await file.text());
    if (parsed.keywordCount === 0) {
      setNotice({
        tone: "warn",
        text: parsed.errors[0] ?? "No keywords found — is this a Lightroom keyword list?",
      });
      return;
    }
    const skipped = parsed.errors.length ? ` — ${parsed.errors.length} line(s) skipped` : "";
    setNotice({
      tone: parsed.errors.length ? "warn" : "info",
      text: `Imported ${stats.added} new, merged ${stats.merged} existing${skipped}`,
    });
  };

  const onExport = () => {
    const text = exportLrText();
    if (!text) {
      setNotice({ tone: "warn", text: "The keyword tree is empty" });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "safelight-keywords.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{ padding: 10 }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_KEYWORD)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData(DND_KEYWORD);
        if (dragged) {
          e.preventDefault();
          moveNodeAction(dragged, null);
        }
      }}
    >
      <ui.Stack gap={8}>
        <EntryField onNotice={setNotice} />

        {notice && (
          <div
            style={{
              borderLeft: `2px solid ${notice.tone === "warn" ? ui.tokens.rating : ui.tokens.accent}`,
              paddingLeft: 8,
              fontSize: 11,
              lineHeight: 1.5,
              color: ui.tokens.textSecondary,
            }}
          >
            {notice.text}
          </div>
        )}

        {filterKeys.length > 0 && (
          <ui.Row gap={6} align="center">
            <span style={{ fontSize: 11, color: ui.tokens.textSecondary }}>
              Filtering by {filterKeys.length} keyword{filterKeys.length > 1 ? "s" : ""}
            </span>
            <ui.Button variant="ghost" size="sm" onClick={clearFilter}>
              Clear
            </ui.Button>
          </ui.Row>
        )}

        {!treeIsEmpty && (
          <ui.TextInput value={search} onChange={setSearch} placeholder="Search keywords…" />
        )}

        {treeIsEmpty && unfiled.length === 0 ? (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: ui.tokens.textMuted }}>
            No keywords yet. Type above to tag the selected photos — use{" "}
            <span style={{ fontFamily: ui.tokens.fontMono }}>Nature &gt; Birds &gt; Eagle</span> to
            create a hierarchy — or import a Lightroom keyword list below.
          </div>
        ) : (
          <div>
            {rows.map(({ data, hasChildren, expanded: isExpanded }) => (
              <React.Fragment key={data.key}>
                <TreeRow
                  data={data}
                  hasChildren={hasChildren}
                  expanded={isExpanded}
                  checkState={checkStateOf(targetCounts.get(data.key) ?? 0, targets.length)}
                  count={counts.get(data.key)?.count ?? 0}
                  deepCount={deepCounts.get(data.key) ?? 0}
                  filterActive={filterKeys.includes(data.key)}
                  renaming={renamingKey === data.key}
                  onRenameStart={() => setRenamingKey(data.key)}
                  onRenameEnd={() => setRenamingKey(null)}
                  onOpenMenu={(e, d) => openMenu(e, menuFor(d, false))}
                  onNotice={say}
                />
                {editingKey === data.key && (
                  <NodeEditor
                    data={data}
                    armDelete={armDelete}
                    onNotice={say}
                    onClose={() => {
                      setEditing(null);
                      setArmDelete(false);
                    }}
                  />
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && !treeIsEmpty && (
              <div style={{ fontSize: 11, color: ui.tokens.textMuted, padding: "4px 0" }}>
                No keywords match "{search}"
              </div>
            )}
          </div>
        )}

        {unfiled.length > 0 && (
          <div>
            <div
              title="Keywords on photos in this catalogue that aren't in your tree yet"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: ui.tokens.textMuted,
                margin: "4px 0 2px",
              }}
            >
              Unfiled
            </div>
            {unfiled.map(({ key, display, count }) => (
              <TreeRow
                key={key}
                data={{ node: createNode(display), key, depth: 0, path: [display] }}
                hasChildren={false}
                expanded={false}
                checkState={checkStateOf(targetCounts.get(key) ?? 0, targets.length)}
                count={count}
                deepCount={count}
                filterActive={filterKeys.includes(key)}
                renaming={false}
                unfiled
                onRenameStart={() => {}}
                onRenameEnd={() => {}}
                onOpenMenu={(e, d) => openMenu(e, menuFor(d, true))}
                onNotice={say}
              />
            ))}
          </div>
        )}

        <ui.Row gap={6} justify="space-between">
          <ui.Button
            variant="ghost"
            size="sm"
            title="Create a top-level keyword"
            onClick={() => setRenamingKey(createChild(null))}
          >
            + New
          </ui.Button>
          <ui.Row gap={6}>
            <ui.Button
              variant="ghost"
              size="sm"
              title="Import a Lightroom keyword list (.txt)"
              onClick={() => fileRef.current?.click()}
            >
              Import…
            </ui.Button>
            <ui.Button
              variant="ghost"
              size="sm"
              title="Export the tree as a Lightroom keyword list (.txt)"
              onClick={onExport}
            >
              Export
            </ui.Button>
          </ui.Row>
        </ui.Row>
      </ui.Stack>

      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void onImportFile(file);
        }}
      />
      {menu}
    </div>
  );
}
