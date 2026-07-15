'use strict';

import { MATRIX_MAX_ENTRIES } from '../config.ts';
import { getFramework } from '../provider-registry.ts';
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
  const fixed: MatrixFixed = {
    model,
    apiKey: body.apiKey || undefined,
    customBaseUrl: body.customBaseUrl || undefined,
    customMcp: body.customMcp || undefined,
    selectedTests,
  };
  return { ok: true, req: { platforms, variants, combos, prompt, fixed, dropped, warnings } };
}
