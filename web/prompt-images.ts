// Prompt-image picker shared by the Interactive and Matrix views: lists the reference
// images available in the host's ./prompt-images/ folder, uploads more straight from the
// browser, and tracks which of them a run attaches to the agent's prompt.
//
// The *listing* is module-level shared state (one host folder, so an upload or delete in
// either view must show up in both — mirrors providers.ts); only the selection is
// per-picker. Each view creates one instance, renders `tpl()` inside a fieldset, and
// reads `selected()` when it submits.
import { html, nothing, repeat, classMap } from './lit.ts';
import { getJSON } from './api.ts';

export interface PromptImage { name: string; size: number; mtime: string }

export interface ImagePicker {
  /** The picker markup — drop it in a fieldset. */
  tpl(): unknown;
  /** Attached image names (ids), in listing order. */
  selected(): string[];
  /** Apply a selection (matrix prefill from a server-side config file). */
  setSelected(names: string[]): void;
}

// ---------- shared listing ----------

let images: PromptImage[] = [];
let dir = './prompt-images';
let maxBytes = 10 * 1024 * 1024;
let listError: string | null = null;
const listeners = new Set<() => void>();

/** (Re)load the available images and notify every picker. Awaited by the matrix prefill. */
export async function refreshPromptImages(): Promise<void> {
  try {
    const j = await getJSON('/api/prompt-images');
    images = j.images || [];
    dir = j.dir || dir;
    if (j.maxBytes) maxBytes = j.maxBytes;
    listError = null;
  } catch {
    listError = 'Could not list prompt images.';
  }
  for (const fn of listeners) fn();
}

const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const thumbUrl = (name: string) => `/api/prompt-images/file?name=${encodeURIComponent(name)}`;

// ---------- picker ----------

// `id` prefixes the DOM ids so the two instances (wizard + matrix) never collide;
// `update` is the owning view's re-render.
export function createImagePicker(id: string, update: () => void): ImagePicker {
  const sel = new Set<string>();
  let note: string | null = null;
  let busy = false;
  const fileInputId = `${id}ImgFile`;

  // Drop selections whose file is gone (deleted on the host, or by the other view).
  listeners.add(() => {
    const avail = new Set(images.map((i) => i.name));
    for (const n of [...sel]) if (!avail.has(n)) sel.delete(n);
    update();
  });

  function toggle(name: string) {
    if (sel.has(name)) sel.delete(name); else sel.add(name);
    note = null;
    update();
  }

  // Upload sends the File object as the raw request body — no multipart, no base64.
  // A freshly uploaded image is auto-selected: you uploaded it to use it.
  async function onFiles(e: Event) {
    // igc-file-input's `files` is the live native FileList — copy it out before the
    // reset below empties it. Its `value` setter only accepts '' (the file list is
    // read-only, like the native input), and clearing it needs an explicit re-render
    // for the component to drop the chosen-file names it shows.
    const input = e.target as any;
    const files: File[] = [...(input.files || [])];
    try { input.value = ''; input.requestUpdate?.(); } catch (_) {}
    if (!files.length) return;
    busy = true;
    note = `Uploading ${files.length} file(s)…`;
    update();
    const failed: string[] = [];
    const added: string[] = [];
    for (const file of files) {
      if (file.size > maxBytes) { failed.push(`${file.name} (over ${fmtSize(maxBytes)})`); continue; }
      try {
        const r = await fetch(`/api/prompt-images?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file,
        });
        const j = await r.json();
        if (!j.ok) { failed.push(`${file.name} (${j.error})`); continue; }
        added.push(j.name);
      } catch (err: any) {
        failed.push(`${file.name} (${err.message})`);
      }
    }
    busy = false;
    // Refresh first (it prunes unknown selections), then attach what was just uploaded.
    await refreshPromptImages();
    for (const name of added) sel.add(name);
    note = failed.length ? `Could not upload: ${failed.join(', ')}` : null;
    update();
  }

  // Deletes the real files from the host folder (that folder IS the working set), so ask.
  async function removeSelected() {
    const names = [...sel];
    if (!names.length) return;
    if (!confirm(`Delete ${names.length} image file(s) from ${dir} on the host?\n\n${names.join('\n')}`)) return;
    busy = true;
    update();
    for (const name of names) {
      try { await fetch(`/api/prompt-images?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
      sel.delete(name);
    }
    busy = false;
    await refreshPromptImages();
  }

  const summary = () => {
    if (note) return note;
    if (listError) return listError;
    if (!images.length) {
      return `No images in ${dir} — drop mockups/screenshots in that folder on the host, or upload them here.`;
    }
    return sel.size
      ? `${sel.size}/${images.length} image(s) attached to the prompt.`
      : `${images.length} image(s) available — click to attach. None attached (text-only prompt).`;
  };

  const item = (img: PromptImage) => {
    const on = sel.has(img.name);
    return html`
      <button type="button" class="img-item ${classMap({ on })}" title=${`${img.name} · ${fmtSize(img.size)}`}
        aria-pressed=${String(on)} @click=${() => toggle(img.name)}>
        <img loading="lazy" decoding="async" src=${thumbUrl(img.name)} alt=${img.name}>
        <span class="cap">${img.name}</span>
        ${on ? html`<span class="tick">✓</span>` : nothing}
      </button>`;
  };

  return {
    tpl: () => html`
      <div class="img-picker">
        <div class="img-strip" ?hidden=${!images.length}>
          ${repeat(images, (i) => i.name, item)}
        </div>
        <div class="img-actions">
          <igc-file-input outlined class="img-file" id=${fileInputId} label="Upload images"
            multiple accept="image/*" .disabled=${busy} @igcChange=${onFiles}>
            <span slot="file-selector-text">Choose…</span>
            <span slot="file-missing-text">png · jpg · webp · gif</span>
          </igc-file-input>
          <button type="button" class="viewbtn" title=${`Re-scan ${dir} on the host`}
            @click=${() => { note = null; refreshPromptImages(); }}>↻ rescan</button>
          <button type="button" class="viewbtn" ?hidden=${!sel.size}
            @click=${() => { sel.clear(); update(); }}>clear selection</button>
          <button type="button" class="icon-btn" ?hidden=${!sel.size} title="Delete the selected files from the host folder"
            @click=${removeSelected}>✕ delete files</button>
        </div>
        <p class="note">${summary()}</p>
        <p class="note warn" ?hidden=${!sel.size}>⚠ Attachments need a <strong>vision-capable paid model</strong> and an
        API key. Free / keyless models (e.g. <code>opencode/big-pickle</code>) can't read images — they ignore or
        reject the attachment, so the run silently falls back to a text-only prompt.</p>
      </div>`,
    selected: () => images.map((i) => i.name).filter((n) => sel.has(n)),
    setSelected: (names: string[]) => {
      sel.clear();
      for (const n of names) sel.add(n);
      update();
    },
  };
}
