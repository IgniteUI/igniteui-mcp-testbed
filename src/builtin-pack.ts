'use strict';

// Ignite UI described in the provider-pack shape, metadata only: what the UI shows and
// validates against (frameworks, options, MCP classes, skills label). The backend still
// runs Ignite UI through FRAMEWORKS and the 'igniteui' configure strategy; phase 3 of
// docs/plan-provider-packs.md replaces this with a real pack.
//
// Class ids stay bare (`igniteui`, `theming`, `angular`) because that is what the
// configure stage's classifier produces and what every existing record stores.

import { FRAMEWORKS } from './frameworks.ts';
import type { PackOption, ProviderPack } from './types.ts';

export const BUILTIN_PROVIDER = 'igniteui';

// In the order the UI lists them.
const FRAMEWORK_LABELS: Array<[string, string]> = [
  ['angular', 'Angular'],
  ['blazor', 'Blazor'],
  ['react', 'React'],
  ['webcomponents', 'Web Comps'],
];

// `type` and `theme` feed `ig new --type= --theme=` (src/frameworks.ts).
const OPTIONS: PackOption[] = [
  { id: 'type', label: 'Project type (optional)', placeholder: 'e.g. igx-ts / sidenav', default: '' },
  { id: 'theme', label: 'Theme (optional)', placeholder: 'e.g. default', default: '' },
];

export type BuiltinPackMeta = Omit<ProviderPack, 'frameworks' | 'dir'> & {
  frameworks: { id: string; label: string }[];
};

export const IGNITEUI_META: BuiltinPackMeta = {
  schemaVersion: 2,
  name: BUILTIN_PROVIDER,
  displayName: 'Ignite UI',
  description: 'Built in. Projects scaffolded by the Ignite UI CLI (Angular, React, Web Components) or the IgniteUI.Blazor.Templates dotnet template.',
  frameworks: FRAMEWORK_LABELS.filter(([id]) => FRAMEWORKS[id]).map(([id, label]) => ({ id, label })),
  options: OPTIONS,
  mcp: {
    classes: [
      { id: 'igniteui', label: 'Ignite UI CLI MCP', description: 'Live component docs & API lookup' },
      { id: 'theming', label: 'Theming MCP', description: 'Palette / theming queries' },
      { id: 'angular', label: 'Angular CLI MCP', description: 'Registered alongside on Angular projects', default: false, frameworks: ['angular'] },
    ],
    servers: [],
  },
  skills: { label: 'Install Ignite UI skills', sources: [] },
  origin: 'builtin',
  hash: '',
};

export const isBuiltinFramework = (id: string): boolean => Object.prototype.hasOwnProperty.call(FRAMEWORKS, id);
