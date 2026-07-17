// Single import point for the lit-html primitives the views render with.
//
// This lit copy is bundled into app.js so the views work even without the Ignite UI
// vendor bundle (host-side dev). It is deliberately NOT used for igc-grid cell/detail
// templates — those are rendered by the grid's own lit instance inside vendor
// igniteui.js, so history.ts builds them with `window.igniteuiHtml` instead (see the
// gridHtml helper there). Keep that boundary: our lit renders the page, the vendor lit
// renders inside the grid.
export { html, render, nothing } from 'lit';
export type { TemplateResult } from 'lit';
export { repeat } from 'lit/directives/repeat.js';
export { classMap } from 'lit/directives/class-map.js';
export { keyed } from 'lit/directives/keyed.js';
