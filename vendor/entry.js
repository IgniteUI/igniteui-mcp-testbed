// Bundle entry for Ignite UI Web Components. esbuild inlines this + all of its
// dependencies (lit, @floating-ui, etc.) into a single self-contained
// public/vendor/igniteui.js at image-build time, so the wizard serves it from
// its own origin with no CDN requests at page load.
//
// Registers every component up front to keep the UI migration friction-free; if
// bundle size ever matters, swap to `defineComponents(IgcInputComponent, ...)`
// with just the components actually used.
import { defineAllComponents, configureTheme } from 'igniteui-webcomponents';
import 'igniteui-webcomponents-grids/grids/combined.js';
import { html } from 'lit';

// Select which compiled shadow-DOM styles the components adopt. The matching
// design tokens (--ig-* custom properties) are supplied by the global
// themes/dark/material.css, linked from the page <head> (copied to
// public/vendor/igniteui-theme.css at build); without those tokens the
// components render unstyled (no borders/box).
configureTheme('material', 'dark');
defineAllComponents();

// Grid cell and master-detail templates are assigned from web/history.ts. Expose
// Lit's template tag from this already-loaded vendor bundle so the app bundle
// does not need another browser module request or a duplicate Lit dependency.
window.igniteuiHtml = html;
