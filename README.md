# Zotero Hide Citation Highlights (Zotero 7+)

Removes the light-blue boxes the Zotero PDF reader paints over detected
**citations** and **cross-reference (internal) links** — the author/year
citations a LaTeX `hyperref` document typically embeds. Links stay fully
clickable and their hover popups still work; only the painted box disappears.

Verified on Zotero 9.0.4.

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

1. **No DOM to style.** Zotero's reader does not use PDF.js's DOM annotation
   layer. It paints these boxes directly onto a `<canvas>` via `ctx.fillRect()`
   in `Renderer._drawOverlays()`. A CSS rule / global agent sheet has nothing
   to match — which is why a stylesheet-based attempt can never work.
2. **Xray boundary.** The reader runs in an iframe (content scope); plugin code
   runs privileged (chrome scope). Reaching content objects from chrome goes
   through Xray wrappers that *hide* the reader's own methods, so a naive
   monkeypatch reads `undefined` and writes an invisible expando. The plugin
   instead compiles a function in the reader's own compartment
   (`window.wrappedJSObject.Function`) and does the work there.
3. **Wrong class.** `_drawOverlays` is on the `Renderer` class, not `Page`.
   Each `Page` holds renderer instances (`_pageRenderer` / `_detailRenderer`);
   the plugin finds their prototype by scanning the page's own fields.
4. **Signature cache.** `Renderer.render()` skips repainting when its content
   digest is unchanged. After no-op'ing the draw, the plugin calls
   `_invalidateSignature()` before `render()` or the box never clears.

## Tuning

- The faint highlight shown *while hovering* a link is left intact (it signals
  clickability). To remove it too, also no-op `_drawHover` wherever the plugin
  no-ops `_drawOverlays`.
- The plugin only suppresses *drawing*, so clicks and citation popups still
  work. It does not alter or strip any link data.

## Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`). Cut one
with the helper script:

```sh
./release.sh v0.1.0
```

It bumps `version` in `manifest.json`, commits, tags, and pushes the tag. The
workflow then verifies the tag matches `manifest.json`, builds the `.xpi`,
attaches it to a release for that tag, and refreshes `updates.json` on a stable
`release` release that Zotero's `update_url` points at (so existing installs
auto-update).
