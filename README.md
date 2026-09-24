# Zotero Hide Citation Highlights (Zotero 7–10)

Removes the light-blue boxes the Zotero PDF reader paints over detected
**citations** and **matched cross-reference (internal) links** — the author/year
citations a LaTeX `hyperref` document typically embeds. Links stay fully
clickable and their hover popups still work; only the painted box disappears.

Verified on Zotero 10.0.3 and Zotero 9.0.4. A single build covers both: the
reader internals moved in Zotero 10, so the plugin probes for either shape at
runtime (see below).

## Install

Download `zotero-hide-citation-highlights.xpi` from the
[latest release](https://github.com/jkroes/zotero-hide-citation-highlights/releases/latest),
then in Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and
pick the `.xpi`. No restart needed; the boxes clear within ~1 second. Zotero
auto-updates the plugin from later releases.

To build locally instead:

```sh
zip -j -X zotero-hide-citation-highlights.xpi manifest.json bootstrap.js
```

## Why this took a real plugin (and not CSS)

Four things make this non-obvious; the plugin handles all four:

1. **Nothing to style.** Zotero does not put these in PDF.js's DOM annotation
   layer. In Zotero 7–9 the reader painted them straight onto a `<canvas>` via
   `ctx.fillRect()`, so there was no element at all. Zotero 10 moved rendering
   to a DOM/SVG overlay (`div.annotationOverlay`), but the citation tints are
   emitted as generic `rect` items carrying only geometry and color — nothing
   marks them as citations, and hover, find-result and annotation rects are
   built identically. So a CSS rule still cannot single them out, on either
   version.
2. **Xray boundary.** The reader runs in an iframe (content scope); plugin code
   runs privileged (chrome scope). Reaching content objects from chrome goes
   through Xray wrappers that *hide* the reader's own methods, so a naive
   monkeypatch reads `undefined` and writes an invisible expando. The plugin
   instead compiles a function in the reader's own compartment
   (`window.wrappedJSObject.Function`) and does the work there.
3. **The hook moved, and it isn't always on `Page`.**

   | | method | owner |
   |---|---|---|
   | Zotero 7–9 | `_drawOverlays` | `Renderer` — instances live in the `Page`'s own fields (`_pageRenderer` / `_detailRenderer`), *not* on the `Page` |
   | Zotero 10 | `_pushOverlays` | `Page` itself — it contributes the citation rects to the display list `Page.render()` diffs |

   The plugin scans each page *and* its own object-valued fields, patching
   whichever prototype actually owns one of the two methods.
4. **Signature cache.** `render()` skips repainting when its content digest is
   unchanged, so no-op'ing the draw does **not** clear boxes already on screen.
   The plugin invalidates first, then repaints — and the way to invalidate
   changed too: Zotero 7–9 exposed `_invalidateSignature()`, while Zotero 10
   keeps a plain `_lastSignature` field (the method is gone), so the plugin
   nulls the field when it finds no method.

Everything is reversible: disabling the plugin restores the original method and
repaints, bringing the boxes back without a restart.

## Tuning

- The faint highlight shown *while hovering* a link is left intact (it signals
  clickability). To remove it too, no-op the hover method alongside the overlay
  one — `_pushHover` on Zotero 10, `_drawHover` on Zotero 7–9.
- The plugin only suppresses *drawing*, so clicks and citation popups still
  work. It does not alter or strip any link data.
- Zotero 10's reflowable text views (`_primarySDTView` / `_secondarySDTView`)
  draw no citation tints today. The plugin walks them anyway, so it keeps
  working if that changes.

## Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`). Cut one
with the helper script:

```sh
./release.sh v0.2.0
```

It bumps `version` in `manifest.json`, commits, tags, and pushes the tag. The
workflow then verifies the tag matches `manifest.json`, builds the `.xpi`,
attaches it to a release for that tag, and refreshes `updates.json` on a stable
`release` release that Zotero's `update_url` points at (so existing installs
auto-update).

Note that `strict_max_version` in `manifest.json` gates installation: Zotero
builds enforce it (`addon.strictCompatibility` is true on any non-beta build),
so it must be raised before a new Zotero major can install the plugin at all.
