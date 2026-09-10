'use strict';

import type { DiagnosticKind } from './types.ts';

// The run-status vocabulary, in ONE place.
//
// Before this file the same list was hardcoded in five: both grids, the matrix step-cell
// if-chain, the standalone matrix report, and the portable history export — each with
// its own copy of the pill CSS. Adding a status meant editing all five, and missing one
// failed silently (the `rate-limited` status shipped on this branch renders unstyled in
// history-export.ts to this day). Every consumer now reads from here.
//
// Deliberately dependency-free apart from a type import, so the esbuild-bundled frontend
// (DOM libs, no Node types) and the Node backend can both import it.

export type StatusTone = 'good' | 'bad' | 'warn' | 'muted';

export interface StatusMeta {
  /** Human label; also the fallback text for the matrix step cell. */
  label: string;
  tone: StatusTone;
}

export const STATUS_META: Record<string, StatusMeta> = {
  success: { label: 'succeeded', tone: 'good' },
  error: { label: 'run failed', tone: 'bad' },
  'build-error': { label: 'build failed', tone: 'warn' },
  'test-failed': { label: 'tests failed', tone: 'bad' },
  // Provider-side outcomes: the run didn't fail, the provider did. Amber, not red.
  'rate-limited': { label: 'rate limited by the provider', tone: 'warn' },
  'provider-down': { label: 'provider unavailable', tone: 'warn' },
  'no-credits': { label: 'provider balance exhausted', tone: 'warn' },
  auth: { label: 'provider rejected the API key', tone: 'warn' },
  'timed-out': { label: 'agent timed out', tone: 'warn' },
  running: { label: 'running', tone: 'warn' },
  pending: { label: 'pending', tone: 'muted' },
  cancelled: { label: 'cancelled', tone: 'muted' },
  interrupted: { label: 'interrupted', tone: 'muted' },
};

/** Statuses with a dedicated `.pill.<status>` rule; anything else renders `.pill.other`. */
export const PILL_STATUSES: string[] = Object.keys(STATUS_META);

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] || { label: status, tone: 'muted' };
}

export function statusLabel(status: string): string {
  return statusMeta(status).label;
}

export function pillClass(status: string): string {
  return STATUS_META[status] ? status : 'other';
}

/** Statuses that mean "the provider, not this run" — used to word the UI honestly. */
export const PROVIDER_STATUSES = new Set(['rate-limited', 'provider-down', 'no-credits', 'auth']);

/** Short chip text per diagnostic kind, for dense surfaces (grid cells, chips). */
export const KIND_CHIP: Record<DiagnosticKind, string> = {
  'rate-limited': '429',
  'no-credits': 'credits',
  auth: 'auth',
  'provider-down': 'provider',
  network: 'network',
  stalled: 'stalled',
  looping: 'looping',
  'timed-out': 'timeout',
  'unknown-provider-error': 'provider',
};
