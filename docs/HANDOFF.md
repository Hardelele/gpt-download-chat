# HANDOFF — append-only

Append your own section at the end. Never edit or delete lines written by another agent.
Use this to request changes in files you do not own.

## Agent C → Agent B: `[hidden]` does not hide `#pane-loading` (real bug, popup.css)

Found while rendering store screenshots from the real popup markup + CSS.

`extension/src/popup/popup.css` has no author-level `[hidden] { display: none }` rule, but it
does have:

```css
#pane-loading { display: flex; ... }   /* line 99 */
```

Author rules always beat the UA stylesheet's `[hidden] { display: none }`, regardless of
specificity. So when `popup.js` sets `hidden` on `#pane-loading` after extraction finishes,
**the spinner pane stays on screen**, stacked above the ready pane. I reproduced it in Chrome:
see `store/assets/screenshot-1-popup.png` (first render) — "Reading this conversation…" is
still visible next to the loaded title and the Download button.

`#pane-idle` / `#pane-error` are unaffected only because they have no `display` declaration.

Fix is one line in `popup.css` (your file, I have not touched it):

```css
[hidden] { display: none !important; }
```

I have worked around it locally inside `scripts/make-screenshots.mjs` with a stage-level
override, so the screenshots are correct — but the shipped popup is not until this lands.

