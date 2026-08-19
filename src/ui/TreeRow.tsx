// One keyword row: disclosure, tri-state check against the current photo
// targets, name (inline-renamable), photo count doubling as the filter toggle,
// and a hover menu. Rows are drag sources (re-parent) and drop targets for
// both other keyword rows and photo drags from the Library grid.

import type { DragEvent, ReactElement } from "react";
import { React, ui } from "../runtime";
import type { KeywordNode } from "../model/tree.ts";
import {
  applyPaths,
  moveNodeAction,
  renameNodeAction,
  toggleFilterKey,
  toggleOnTargets,
  toggleExpanded,
  type CheckState,
} from "../store";

export const DND_KEYWORD = "application/x-hk-keyword";
export const DND_PHOTOS = "application/x-safelight-photos";

export interface RowData {
  node: KeywordNode;
  key: string;
  depth: number;
  path: string[];
}

export interface TreeRowProps {
  data: RowData;
  hasChildren: boolean;
  expanded: boolean;
  checkState: CheckState;
  count: number;
  deepCount: number;
  filterActive: boolean;
  renaming: boolean;
  unfiled?: boolean;
  onRenameStart(): void;
  onRenameEnd(): void;
  onOpenMenu(e: { clientX: number; clientY: number }, data: RowData): void;
  onNotice(text: string): void;
}

export function TreeRow(props: TreeRowProps): ReactElement {
  const { data, hasChildren, expanded, checkState, count, deepCount, filterActive } = props;
  const [hover, setHover] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);

  const acceptsDrop = (e: DragEvent) =>
    (e.dataTransfer.types.includes(DND_KEYWORD) || e.dataTransfer.types.includes(DND_PHOTOS)) &&
    !props.unfiled;

  return (
    <div
      draggable={!props.renaming && !props.unfiled}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_KEYWORD, data.key);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND_PHOTOS) ? "copy" : "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const photoJson = e.dataTransfer.getData(DND_PHOTOS);
        if (photoJson) {
          try {
            const ids = JSON.parse(photoJson) as string[];
            if (Array.isArray(ids) && ids.length > 0) {
              void applyPaths([[data.node.name]], ids).then(() =>
                props.onNotice(
                  `Tagged ${ids.length} photo${ids.length > 1 ? "s" : ""} with "${data.node.name}"`,
                ),
              );
            }
          } catch {
            // not our payload
          }
          return;
        }
        const dragged = e.dataTransfer.getData(DND_KEYWORD);
        if (dragged && dragged !== data.key && !moveNodeAction(dragged, data.key)) {
          props.onNotice("Can't move a keyword into its own branch");
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onOpenMenu(e, data);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 4px 1px 0",
        paddingLeft: data.depth * 14,
        borderRadius: 4,
        background: dropping ? ui.tokens.surface3 : hover ? ui.tokens.surface2 : "transparent",
        outline: dropping ? `1px solid ${ui.tokens.accent}` : "none",
      }}
    >
      {hasChildren ? (
        <span
          onClick={() => toggleExpanded(data.key)}
          title={expanded ? "Collapse" : "Expand"}
          style={{
            width: 14,
            textAlign: "center",
            fontSize: 9,
            color: ui.tokens.textMuted,
            cursor: "pointer",
            userSelect: "none",
            transform: expanded ? "rotate(90deg)" : "none",
          }}
        >
          ▶
        </span>
      ) : (
        <span style={{ width: 14 }} />
      )}

      <TriCheck state={checkState} onClick={() => void toggleOnTargets(data.key)} />

      {props.renaming ? (
        <RenameInput data={data} onDone={props.onRenameEnd} onNotice={props.onNotice} />
      ) : (
        <span
          onDoubleClick={props.unfiled ? undefined : () => props.onRenameStart()}
          title={data.node.synonyms.length > 0 ? `Synonyms: ${data.node.synonyms.join(", ")}` : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            color: props.unfiled ? ui.tokens.textSecondary : ui.tokens.textPrimary,
            fontStyle: props.unfiled ? "italic" : "normal",
            userSelect: "none",
          }}
        >
          {data.node.name}
          {!data.node.includeOnExport && (
            <span title="Excluded from export" style={{ color: ui.tokens.textMuted }}>
              {" "}
              ⊘
            </span>
          )}
        </span>
      )}

      <span
        onClick={(e) => toggleFilterKey(data.key, e.ctrlKey || e.metaKey)}
        title={
          (deepCount !== count ? `${count} photos (${deepCount} incl. children) — ` : `${count} photos — `) +
          "click to filter, Ctrl+click to add to filter"
        }
        style={{
          fontSize: 10,
          fontFamily: ui.tokens.fontMono,
          lineHeight: "14px",
          minWidth: 18,
          textAlign: "center",
          borderRadius: 7,
          padding: "0 4px",
          cursor: "pointer",
          userSelect: "none",
          color: filterActive ? ui.tokens.surface0 : ui.tokens.textMuted,
          background: filterActive ? ui.tokens.accent : "transparent",
        }}
      >
        {count}
      </span>

      <span
        onClick={(e) => props.onOpenMenu(e, data)}
        title="Keyword menu"
        style={{
          width: 16,
          textAlign: "center",
          cursor: "pointer",
          color: ui.tokens.textMuted,
          fontSize: 12,
          userSelect: "none",
          visibility: hover ? "visible" : "hidden",
        }}
      >
        ⋯
      </span>
    </div>
  );
}

function TriCheck({ state, onClick }: { state: CheckState; onClick(): void }): ReactElement {
  return (
    <span
      onClick={onClick}
      role="checkbox"
      aria-checked={state === "on" ? "true" : state === "mixed" ? "mixed" : "false"}
      title={state === "on" ? "Remove from selected photos" : "Apply to selected photos"}
      style={{
        width: 13,
        height: 13,
        flexShrink: 0,
        borderRadius: 3,
        border: `1px solid ${state === "off" ? ui.tokens.border : ui.tokens.accent}`,
        background: state === "on" ? ui.tokens.accent : "transparent",
        color: state === "on" ? ui.tokens.surface0 : ui.tokens.accent,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        lineHeight: 1,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {state === "on" ? "✓" : state === "mixed" ? "–" : ""}
    </span>
  );
}

function RenameInput({
  data,
  onDone,
  onNotice,
}: {
  data: RowData;
  onDone(): void;
  onNotice(text: string): void;
}): ReactElement {
  const [name, setName] = React.useState(data.node.name);
  const boxRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    const input = boxRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, []);

  const commit = async () => {
    if (name.trim() && name !== data.node.name) {
      const res = await renameNodeAction(data.key, name);
      if (res.message) onNotice(res.message);
    }
    onDone();
  };

  return (
    <span ref={boxRef} style={{ flex: 1, minWidth: 0 }}>
      <ui.TextInput
        value={name}
        onChange={setName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void commit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => void commit()}
      />
    </span>
  );
}
