'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { PROMPT_IMAGES_DIR, PROMPT_IMAGE_MAX_COUNT } from './config.ts';
import type { Emit, PromptImage } from './types.ts';

// Reference images attached to the agent's prompt — design mockups, hand sketches,
// screenshots of an existing app — so "build this screen" can be tested with the image
// as the actual specification. They live in the host folder bind-mounted at
// PROMPT_IMAGES_DIR (read-write, so browser uploads and a terminal-driven config's
// folder are one and the same place) and are referenced by a path relative to it.
//
// A run consumes them twice: the pipeline stages copies into `<appDir>/prompt-images/`
// (so an interactive opencode session can @-mention them and the session dir records
// what the agent was shown), and a headless run additionally passes those copies to
// `opencode run … --file <img>`, which is how the image reaches the model.

// Extensions we accept as attachable images. Deliberately raster-only: SVG is markup
// (the agent can just read it) and vision models take bitmaps.
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
// Folders may be used to group mockups per scenario; the walk is bounded so a stray
// deep tree in the mount can't turn a listing into a filesystem crawl.
const MAX_DEPTH = 4;

export const isImageName = (name: string): boolean => IMAGE_RE.test(name);

export function ensureImagesDir(): void {
  try { fs.mkdirSync(PROMPT_IMAGES_DIR, { recursive: true }); } catch (_) {}
}

// Resolve a user/config-supplied relative path inside PROMPT_IMAGES_DIR, or null when
// it escapes the dir (absolute path, `..`, symlink-ish tricks). Every path that reaches
// the filesystem goes through here — the names come from HTTP queries and config files.
export function safeResolve(rel: string): string | null {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const cleaned = rel.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) return null;
  const base = path.resolve(PROMPT_IMAGES_DIR);
  const abs = path.resolve(base, cleaned);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function walk(dir: string, base: string, depth: number, out: PromptImage[]): PromptImage[] {
  if (depth > MAX_DEPTH) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, base, depth + 1, out); continue; }
    if (!IMAGE_RE.test(e.name)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({
      name: path.relative(base, full).split(path.sep).join('/'),
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  return out;
}

// Every image available to attach, newest first (an upload lands at the top of the UI).
export function listImages(): PromptImage[] {
  const base = path.resolve(PROMPT_IMAGES_DIR);
  return walk(base, base, 0, []).sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
}

export interface ResolvedSelection {
  images: { name: string; abs: string }[];
  /** Entries that matched no image file — surfaced as warnings, never a hard failure. */
  missing: string[];
}

// Turn a selection into concrete image files. An entry may name a single image or a
// folder (expanded to every image inside it, so `"images": ["dashboard"]` works and the
// recorded config still lists exactly what the agent got). Order follows the selection;
// duplicates collapse.
export function resolveSelection(names: string[]): ResolvedSelection {
  const seen = new Set<string>();
  const images: { name: string; abs: string }[] = [];
  const missing: string[] = [];
  const push = (name: string, abs: string) => {
    if (seen.has(name)) return;
    seen.add(name); images.push({ name, abs });
  };
  for (const raw of names) {
    const abs = safeResolve(raw);
    let st: fs.Stats | null = null;
    if (abs) { try { st = fs.statSync(abs); } catch { st = null; } }
    if (!abs || !st) { missing.push(raw); continue; }
    if (st.isDirectory()) {
      const base = path.resolve(PROMPT_IMAGES_DIR);
      const inside = walk(abs, base, 0, []).sort((a, b) => a.name.localeCompare(b.name));
      if (!inside.length) { missing.push(raw); continue; }
      for (const img of inside) push(img.name, path.join(base, img.name));
      continue;
    }
    if (!IMAGE_RE.test(abs)) { missing.push(raw); continue; }
    push(raw.trim().replace(/\\/g, '/'), abs);
  }
  return { images, missing };
}

// Store an uploaded image. The filename comes from the browser, so it is reduced to a
// safe basename and de-duplicated rather than trusted (or allowed to overwrite an
// existing mockup). Returns the stored name (the id the UI selects by).
export function saveUpload(rawName: string, body: Buffer): string {
  if (!body || !body.length) throw new Error('empty upload');
  const base = path.basename(String(rawName || '').replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..') throw new Error('missing or invalid file name');
  if (!IMAGE_RE.test(base)) throw new Error(`unsupported file type (expected ${IMAGE_RE.source.replace(/[\\()]/g, '')})`);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'image';
  ensureImagesDir();
  let name = `${stem}${ext.toLowerCase()}`;
  for (let n = 1; fs.existsSync(path.join(PROMPT_IMAGES_DIR, name)); n++) {
    name = `${stem}-${n}${ext.toLowerCase()}`;
  }
  fs.writeFileSync(path.join(PROMPT_IMAGES_DIR, name), body);
  return name;
}

// Delete one image from the host folder (the UI's ✕). Only files inside the mount and
// only images — never a directory, so a mis-typed name can't wipe a whole group.
export function removeImage(name: string): boolean {
  const abs = safeResolve(name);
  if (!abs || !IMAGE_RE.test(abs)) return false;
  try {
    if (!fs.statSync(abs).isFile()) return false;
    fs.unlinkSync(abs);
    return true;
  } catch (_) { return false; }
}

// Copy the selected images into `<appDir>/prompt-images/` and return the absolute staged
// paths (what `opencode run --file` is given). The folder is intentionally NOT dot-
// prefixed: opencode's file browser / @-mentions skip hidden dirs, and an interactive
// session needs to be able to point at these. Names are flattened to basenames (with a
// counter on collision) so `@prompt-images/home.png` is short enough to type.
//
// Only paths that actually copied are returned: `opencode run --file <missing>` exits
// with "File not found" and fails the whole entry, so a staging failure must drop that
// one image rather than poison the run.
export function stageImages(names: string[], appDir: string, emit: Emit): string[] {
  const { images, missing } = resolveSelection(names);
  for (const m of missing) emit('log', `warning: prompt image "${m}" not found under ${PROMPT_IMAGES_DIR}; skipped`);
  if (!images.length) {
    emit('log', 'no prompt images resolved; nothing attached');
    return [];
  }
  const capped = images.slice(0, PROMPT_IMAGE_MAX_COUNT);
  if (images.length > capped.length) {
    emit('log', `warning: ${images.length - capped.length} prompt image(s) dropped (cap is ${PROMPT_IMAGE_MAX_COUNT})`);
  }
  const dest = path.join(appDir, 'prompt-images');
  fs.mkdirSync(dest, { recursive: true });
  const staged: string[] = [];
  const used = new Set<string>();
  for (const img of capped) {
    const ext = path.extname(img.name);
    const stem = path.basename(img.name, ext);
    let file = `${stem}${ext}`;
    for (let n = 1; used.has(file); n++) file = `${stem}-${n}${ext}`;
    used.add(file);
    const target = path.join(dest, file);
    try {
      fs.copyFileSync(img.abs, target);
      staged.push(target);
      emit('log', `attached image: ${img.name} → prompt-images/${file}`);
    } catch (e: any) {
      emit('log', `warning: could not stage prompt image "${img.name}" (${e.message})`);
    }
  }
  return staged;
}
