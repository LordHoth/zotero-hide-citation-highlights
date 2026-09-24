/* Zotero Hide Citation Highlights — Zotero 7–10 bootstrap plugin
 *
 * WHAT THIS HIDES
 *   The light-blue boxes the Zotero PDF reader paints over detected citations
 *   and matched cross-reference (internal) links — e.g. the author/year
 *   citations a LaTeX `hyperref` document embeds. Links stay clickable and
 *   their popups still work; only the persistent tint is removed.
 *
 * WHY A MONKEYPATCH IS STILL THE ONLY WAY
 *   1. Nothing to style. Zotero does not put these in PDF.js's DOM annotation
 *      layer. In Zotero 7–9 the reader painted them onto a <canvas> with
 *      ctx.fillRect(), so there was no element at all. Zotero 10 moved to a
 *      DOM/SVG overlay (div.annotationOverlay), but the citation tints are
 *      emitted as generic `rect` items carrying only geometry/color — nothing
 *      distinguishes them from hover, find-result or annotation rects — so a
 *      CSS rule still cannot single them out.
 *   2. Xray boundary. The reader runs in an iframe (content scope); plugin
 *      code runs privileged (chrome scope). Reaching content objects from
 *      chrome goes through Xray wrappers that HIDE the reader's own methods,
 *      so a chrome-side monkeypatch silently writes an invisible expando. We
 *      therefore build a function in the reader's OWN compartment
 *      (cw.wrappedJSObject.Function) and do all the work there.
 *   3. The hook moved between majors, so we probe for both and one build
 *      works across versions:
 *        Zotero 7–9   Renderer.prototype._drawOverlays — Renderer instances
 *                     are held in the Page's own fields (_pageRenderer /
 *                     _detailRenderer), not on the Page itself.
 *        Zotero 10    Page.prototype._pushOverlays — on the Page itself. It
 *                     contributes the citation rects to the display list that
 *                     Page.render() diffs and applies.
 *   4. Signature cache. render() skips repainting when its content digest is
 *      unchanged, so no-oping the draw does NOT clear boxes already on screen.
 *      We must invalidate first:
 *        Zotero 7–9   renderer._invalidateSignature()
 *        Zotero 10    page._lastSignature = null  (a plain field now; the
 *                     _invalidateSignature method no longer exists)
 *
 *   Zotero 10 ships reader.js unminified; earlier builds were minified but did
 *   not mangle property names, so _pushOverlays / _drawOverlays / _pages /
 *   _primaryView / _internalReader / _iframeWindow are stable. Everything is
 *   reversible: shutdown restores the original method and repaints.
 */

var HideCitationHighlights = {
  id: "hide-citation-highlights@jkroes",
  timer: null,
  _win: null,
  _workers: null, // WeakMap<readerWindow, { [cacheKey]: contentFunction }>

  log(msg) {
    try { Zotero.debug("[HideCitationHighlights] " + msg); } catch (e) {}
  },

  // Shared prelude for the functions compiled in the reader's compartment.
  //   hookOf(p)      -> name of the overlay-draw method owned by prototype p
  //   candidates(pg) -> the page plus its own object-valued fields, i.e. every
  //                     object that might carry the hook on either version
  //   invalidate(o)  -> drop the render signature so the next render repaints
  HELPERS: `
    function hookOf(p) {
      if (!p) return null;
      if (Object.prototype.hasOwnProperty.call(p, "_pushOverlays")) return "_pushOverlays";
      if (Object.prototype.hasOwnProperty.call(p, "_drawOverlays")) return "_drawOverlays";
      return null;
    }
    function candidates(page) {
      var out = [page];
      var names = Object.getOwnPropertyNames(page);
      for (var i = 0; i < names.length; i++) {
        var val;
        try { val = page[names[i]]; } catch (e) { continue; }
        if (val && typeof val === "object") out.push(val);
      }
      return out;
    }
    function invalidate(obj) {
      try {
        if (typeof obj._invalidateSignature === "function") {
          obj._invalidateSignature();
        } else {
          obj._lastSignature = null;
        }
      } catch (e) {}
    }
  `,

  // Runs in the reader's own compartment. For each page: find the prototype
  // that owns the overlay hook, install a no-op once, and on first sight of a
  // page invalidate its signature and repaint so existing boxes clear.
  // Idempotent — repeat passes are near no-ops.
  PATCH_BODY: `
    if (!view || !view._pages || !view._pages.length) return 0;
    var patched = 0;
    for (var k = 0; k < view._pages.length; k++) {
      var page = view._pages[k];
      if (!page || typeof page !== "object") continue;
      var done = page.__hideLinks_done;
      var objs = candidates(page);
      for (var c = 0; c < objs.length; c++) {
        var obj = objs[c];
        var p = Object.getPrototypeOf(obj);
        var hook = hookOf(p);
        if (!hook) continue;
        if (!p.__hideLinks_orig) {
          p.__hideLinks_orig = p[hook];
          p.__hideLinks_hook = hook;
          p[hook] = function () {};
          patched++;
        }
        if (!done) invalidate(obj);
      }
      if (!done) {
        page.__hideLinks_done = true;
        try { page.render(); } catch (e) {}
      }
    }
    return patched;
  `,

  // Restore the original draw method on every patched prototype and repaint so
  // the boxes come back. Note the invalidate() call is driven by hookOf(), not
  // by __hideLinks_orig: the expando is deleted while handling the first page,
  // and every later page sharing that prototype still needs a repaint.
  RESTORE_BODY: `
    if (!view || !view._pages) return;
    for (var k = 0; k < view._pages.length; k++) {
      var page = view._pages[k];
      if (!page || typeof page !== "object") continue;
      var objs = candidates(page);
      for (var c = 0; c < objs.length; c++) {
        var obj = objs[c];
        var p = Object.getPrototypeOf(obj);
        var hook = hookOf(p);
        if (!hook) continue;
        if (p.__hideLinks_orig) {
          p[p.__hideLinks_hook || hook] = p.__hideLinks_orig;
          delete p.__hideLinks_orig;
          delete p.__hideLinks_hook;
        }
        invalidate(obj);
      }
      delete page.__hideLinks_done;
      try { page.render(); } catch (e) {}
    }
  `,

  // Build (and cache) a function compiled in the reader window's own scope.
  worker(cw, body, cacheKey) {
    if (!cw || !cw.wrappedJSObject) return null;
    if (cacheKey) {
      let cached = this._workers.get(cw);
      if (cached && cached[cacheKey]) return cached[cacheKey];
    }
    let fn = new cw.wrappedJSObject.Function("view", this.HELPERS + body);
    if (cacheKey) {
      let bag = this._workers.get(cw) || {};
      bag[cacheKey] = fn;
      this._workers.set(cw, bag);
    }
    return fn;
  },

  runOnReader(reader, body, cacheKey) {
    try {
      const Cu = Components.utils;
      const cw = reader && reader._iframeWindow;
      const fn = this.worker(cw, body, cacheKey);
      if (!fn) return;
      const ir = Cu.waiveXrays(reader._internalReader);
      if (!ir) return;
      // Zotero 10 adds the reflowable SDT views. They have no citation tints
      // today, so the bodies no-op on them; listed for forward compatibility.
      const views = [
        ir._primaryView,
        ir._secondaryView,
        ir._primarySDTView,
        ir._secondarySDTView,
      ];
      for (const rawView of views) {
        if (rawView) {
          try { fn(Cu.waiveXrays(rawView)); } catch (e) { this.log("view error: " + e); }
        }
      }
    } catch (e) {
      this.log("runOnReader error: " + e);
    }
  },

  sweep() {
    try {
      const readers = Zotero.Reader && Zotero.Reader._readers;
      if (!readers) return;
      for (const reader of readers) this.runOnReader(reader, this.PATCH_BODY, "patch");
    } catch (e) {
      this.log("sweep error: " + e);
    }
  },

  start() {
    this._workers = new WeakMap();
    this.sweep();
    // Pages render asynchronously after a reader opens, and readers open at
    // any time, so poll. Once everything is patched, passes are near no-ops.
    if (typeof setInterval !== "undefined") {
      this._win = { setInterval, clearInterval };
    } else {
      this._win = Zotero.getMainWindow();
    }
    this.timer = this._win.setInterval(() => this.sweep(), 1000);
  },

  stop() {
    try {
      if (this.timer && this._win) this._win.clearInterval(this.timer);
    } catch (e) {}
    this.timer = null;
    try {
      for (const reader of (Zotero.Reader && Zotero.Reader._readers) || []) {
        this.runOnReader(reader, this.RESTORE_BODY, null);
      }
    } catch (e) {}
    this._workers = null;
  },
};

function startup() {
  HideCitationHighlights.start();
}

function shutdown() {
  HideCitationHighlights.stop();
}

function install() {}
function uninstall() {}
