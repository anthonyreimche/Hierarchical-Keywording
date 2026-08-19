# Hierarchical Keywording

Lightroom-class hierarchical keywords for SafeLight. Organize your vocabulary as a tree (`Animals > Birds > Eagle`), apply keywords with autocomplete, checkboxes, or drag-and-drop, filter the library by any branch, and exchange complete keyword lists with Lightroom.

SafeLight's flat keywords stay exactly as they are — photos keep plain keyword strings that every other tool (filters, badges, sidecars, exports) already understands. This extension adds the organizational layer on top: the hierarchy lives in your keyword tree, follows you across projects, and never locks your photos into a proprietary format.

## The Keyword Tree panel

Docked on the left side of the Library (View menu ▸ Keyword Tree if you've closed it).

- **Entry field** — type comma-separated keywords and press Enter to tag the selected photos. `Nature > Birds > Eagle` (or `Nature|Birds|Eagle`) creates the whole path at once. Autocomplete matches names *and synonyms*, showing each keyword's full path; ↑/↓ navigate, Tab completes, Enter applies. Recent keywords sit underneath as one-click chips.
- **Checkboxes** — each row shows whether the selected photos carry that keyword: checked (all), dash (some), empty (none). Click to apply or remove across the whole selection.
- **Counts & filtering** — the number on each row is how many photos carry the keyword (hover for the branch total). Click it to filter the grid to that keyword **including everything under it**; Ctrl+click adds more keywords as OR terms. Composes with the built-in rating/flag/label filters, and Clear filters resets it too.
- **Search** — the search box finds keywords by name or synonym anywhere in a large tree, showing matches in context.
- **Drag and drop** — drag photos from the grid onto a keyword to tag them; drag keyword rows onto each other to restructure the tree (drop on empty panel space to move to top level).
- **Editing** — double-click to rename (renaming onto an existing keyword merges them, retagging photos). The ⋯ menu adds children, applies/removes, filters, and opens the details editor: synonyms, export flags, parent picker, and delete (which shows exactly how many keywords and photos are affected before you commit).
- **Unfiled** — keywords found on photos but not in your tree (old projects, other apps) are listed separately, ready to file, filter, or leave as they are.

## Working with other apps

- **Lightroom keyword lists (.txt)** — Import and Export use Lightroom Classic's exported-keyword-list format: tab indentation, `[keyword]` for "don't export", `{synonym}` lines. Purchased controlled vocabularies import directly; your tree exports back the same way.
- **XMP sidecars** — when photos arrive with sidecars written by Lightroom or darktable, the hierarchy in `lr:hierarchicalSubject` is learned into your tree automatically, and flat keywords pick up any hierarchical leaves `dc:subject` missed. Reading only — sidecar *writing* stays with the XMP Tools extension, so each file has one writer.
- **Flat-only consumers** — by default a photo gets just the keyword you applied, with parents implied by the tree (Lightroom's model). Turn on *"Also tag ancestor keywords on photos"* in the extension's settings to write the full chain as flat keywords instead, so the hierarchy stays visible to apps that only read `dc:subject`.

## Per-keyword export flags

Each keyword carries Lightroom's three flags — *Include on export*, *Export parent keywords*, *Export synonyms* — editable in the details editor and round-tripped through `.txt` import/export (`[brackets]` mark excluded keywords, exactly as Lightroom writes them).

## Shortcuts

- **Ctrl+K** — open the panel and focus the keyword entry (rebindable in Preferences ▸ Shortcuts; plain `K` still focuses the built-in flat editor).
- Right-click photos ▸ **Add keywords…** targets them and opens the entry.

## Development

```
npm install
npm run build          # bundle → index.js
npm run install-local  # build + copy into SafeLight's plugins dir
npm test               # model unit tests (tree ops, LR .txt, paths, XMP)
npm run smoke          # build + mocked-API smoke test
npm run typecheck
```

Single-file ESM bundle, classic-JSX against the app's React (`api.react`), inline styles over `api.ui` primitives and tokens. The tree persists via extension settings and syncs across windows; photo keyword writes go through the core catalog store, so sidecar writers and the catalog file stay in step.

## License

MIT
