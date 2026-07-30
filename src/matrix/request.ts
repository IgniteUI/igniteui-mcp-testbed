'use strict';

import { MATRIX_MAX_ENTRIES, PROMPT_IMAGES_DIR, PROMPT_IMAGE_MAX_COUNT } from '../config.ts';
import { getFramework } from '../provider-registry.ts';
import { resolveSelection } from '../prompt-images.ts';
import { parseVariants, variantLabel } from './variants.ts';
import type { Combo, MatrixFixed, Variant } from '../types.ts';

// A matrix request (the POST /api/matrix body or a MATRIX_CONFIG file) normalized
// into what the engine consumes: filtered axes, the capped cartesian, and the fixed
// per-entry config. Shared by the route and the config-file loader so both paths
// validate identically.
export interface NormalizedMatrixRequest {
  platforms: string[];
  variants: Variant[];
  combos: Combo[];
  prompt: string;
  name: string | null;
  fixed: MatrixFixed;
  dropped: number;
  warnings: string[];
}

export type MatrixRequestResult =
  | { ok: true; req: NormalizedMatrixRequest }
  | { ok: false; error: string };

export function normalizeMatrixRequest(raw: any): MatrixRequestResult {
  const body = raw || {};
  const requested: string[] = Array.isArray(body.platforms) ? body.platforms : [];
  // Provider-aware: a platform is any built-in framework id OR a framework id
  // registered by an external provider pack (provider-registry.getFramework).
  const platforms = requested.filter((p: string) => getFramework(p));
  const warnings: string[] = requested
    .filter((p: string) => !getFramework(p))
    .map((p: string) => `unknown platform '${p}' ignored`);
  const variants = parseVariants(body.variants);
  const model = String(body.model || '').trim();
  const prompt = String(body.prompt || '').trim();
  // Optional human label for the whole matrix, recorded on every entry's history
  // record so a submission is findable later without decoding timestamps.
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  if (!platforms.length || !variants.length) {
    return { ok: false, error: 'select at least one platform and one variant' };
  }
  if (!model) return { ok: false, error: 'a model is required for matrix runs' };
  if (!prompt) return { ok: false, error: 'a prompt is required for matrix runs' };

  let combos: Combo[] = [];
  for (const platform of platforms) for (const variant of variants) {
    combos.push({ platform, variant, variantLabel: variantLabel(variant) });
  }
  let dropped = 0;
  if (combos.length > MATRIX_MAX_ENTRIES) {
    dropped = combos.length - MATRIX_MAX_ENTRIES;
    combos = combos.slice(0, MATRIX_MAX_ENTRIES);
    warnings.push(`combos capped at ${MATRIX_MAX_ENTRIES}; ${dropped} dropped`);
  }

  const selectedTests = Array.isArray(body.selectedTests)
    ? body.selectedTests.filter((t: unknown) => typeof t === 'string')
    : undefined;

  // Reference images attached to the prompt — one fixed set for every entry (they
  // describe *what* to build, which is the shared axis-independent part of the run).
  // `images` is the config-file spelling, `promptImages` the API/UI one. Folder entries
  // are expanded here so each entry's history record lists the actual files.
  const rawImages: unknown = Array.isArray(body.promptImages) ? body.promptImages
    : Array.isArray(body.images) ? body.images : undefined;
  let promptImages: string[] | undefined;
  if (Array.isArray(rawImages)) {
    const { images, missing } = resolveSelection(rawImages.filter((s): s is string => typeof s === 'string'));
    for (const m of missing) {
      warnings.push(`prompt image '${m}' matched no image file under ${PROMPT_IMAGES_DIR}`);
    }
    promptImages = images.map((i) => i.name);
    if (promptImages.length > PROMPT_IMAGE_MAX_COUNT) {
      warnings.push(`prompt images capped at ${PROMPT_IMAGE_MAX_COUNT}; ${promptImages.length - PROMPT_IMAGE_MAX_COUNT} dropped`);
      promptImages = promptImages.slice(0, PROMPT_IMAGE_MAX_COUNT);
    }
  }

  const fixed: MatrixFixed = {
    model,
    apiKey: body.apiKey || undefined,
    customBaseUrl: body.customBaseUrl || undefined,
    customMcp: body.customMcp || undefined,
    selectedTests,
    promptImages,
  };
  return { ok: true, req: { platforms, variants, combos, prompt, name, fixed, dropped, warnings } };
}
