import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  toHex,
  type DesignContextNode,
  type SerializedPaint,
  type SimplifiedPaint,
} from '@figwright/shared';

import { truncationNote } from '../../mcp/src/repo-walk.js';
import { normHex } from '../../mcp/src/tokens/hex.js';
import { parseTailwindConfig, parseUnoConfig } from '../../mcp/src/tokens/js-config.js';
import { aggregateRepoCssTokens } from '../../mcp/src/tokens/repo-css.js';
import { aggregateRepoScssTokens } from '../../mcp/src/tokens/repo-scss.js';
import { type ProjectToken, refOf } from '../../mcp/src/tokens/tokens.js';
import { buildDependencyCatalog, type DependencyCatalog } from './dependency-catalog.js';
import { analyzePortableProject, type PortableProjectProfile } from './project-grounding.js';

const MAX_CANDIDATES = 3;
const SCAN_MODE = 'portable-css-scss-js-config' as const;
const JS_CONFIG_EXTENSION = /\.[cm]?[jt]s$/i;

type ColorProperty =
  | 'fills'
  | 'fills.gradientStops'
  | 'strokes'
  | 'strokes.gradientStops'
  | 'effects'
  | 'segments.fills'
  | 'segments.fills.gradientStops';

type StyleSlot = 'fill' | 'stroke' | 'effect' | 'text';

export interface KiwiTokenCandidate {
  token: string;
  ref: string;
  cssVar?: string;
  utility?: string;
  from?: string;
  confidence: number;
  matchedBy: ['value'];
}

export interface KiwiTokenMapping {
  figmaValue: string;
  figmaType: 'COLOR';
  source: 'observed-value';
  nodeIds: string[];
  properties: ColorProperty[];
  styleRefs?: string[];
  status: 'medium' | 'ambiguous' | 'unmapped';
  candidate?: KiwiTokenCandidate;
  candidates?: KiwiTokenCandidate[];
  candidateCount?: number;
}

export interface KiwiStyleReference {
  id: string;
  slots: StyleSlot[];
  nodeIds: string[];
}

export interface KiwiTokenMapResult {
  mappings: KiwiTokenMapping[];
  unmapped: string[];
  ambiguous: string[];
  unresolvedStyleRefs: KiwiStyleReference[];
  profile: PortableProjectProfile;
  projectTokenCount: number;
  localTokenCount: number;
  dependencyTokenCount: number;
  dependencyPackages: string[];
  tokenFiles: string[];
  scanMode: typeof SCAN_MODE;
  variableBindings: 'unavailable';
  caveats: string[];
  truncationNote?: string;
}

interface ColorUsage {
  nodeIds: Set<string>;
  properties: Set<ColorProperty>;
  styleRefs: Set<string>;
}

interface StyleUsage {
  slots: Set<StyleSlot>;
  nodeIds: Set<string>;
}

interface StaticConfigScan {
  tokens: ProjectToken[];
  files: string[];
  caveats: string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const addStyleRef = (
  usages: Map<string, StyleUsage>,
  id: string | undefined,
  slot: StyleSlot,
  nodeId: string,
): void => {
  if (id === undefined) return;
  const usage = usages.get(id) ?? { slots: new Set<StyleSlot>(), nodeIds: new Set<string>() };
  usage.slots.add(slot);
  usage.nodeIds.add(nodeId);
  usages.set(id, usage);
};

const addColor = (
  usages: Map<string, ColorUsage>,
  raw: string,
  nodeId: string,
  property: ColorProperty,
  styleRef?: string,
): void => {
  const value = normHex(raw);
  if (value === null) return;
  const usage =
    usages.get(value) ??
    ({
      nodeIds: new Set<string>(),
      properties: new Set<ColorProperty>(),
      styleRefs: new Set<string>(),
    } satisfies ColorUsage);
  usage.nodeIds.add(nodeId);
  usage.properties.add(property);
  if (styleRef !== undefined) usage.styleRefs.add(styleRef);
  usages.set(value, usage);
};

const collectPaints = (
  usages: Map<string, ColorUsage>,
  nodeId: string,
  paints: readonly SerializedPaint[] | undefined,
  property: 'fills' | 'strokes' | 'segments.fills',
  styleRef?: string,
): void => {
  for (const paint of paints ?? []) {
    if (!paint.visible) continue;
    if (paint.type === 'SOLID') {
      addColor(usages, toHex(paint.color, paint.opacity), nodeId, property, styleRef);
      continue;
    }
    if (!('gradientStops' in paint)) continue;
    const stopProperty = `${property}.gradientStops` as ColorProperty;
    for (const stop of paint.gradientStops) {
      addColor(usages, toHex(stop.color, stop.color.a), nodeId, stopProperty, styleRef);
    }
  }
};

const collectSimplifiedPaints = (
  usages: Map<string, ColorUsage>,
  nodeId: string,
  paints: readonly SimplifiedPaint[],
  styleRef?: string,
): void => {
  for (const paint of paints) {
    if (paint.visible === false) continue;
    if (paint.color !== undefined) {
      addColor(usages, paint.color, nodeId, 'segments.fills', styleRef);
    }
    for (const stop of paint.gradientStops ?? []) {
      addColor(usages, stop.color, nodeId, 'segments.fills.gradientStops', styleRef);
    }
  }
};

const collectNodeGrounding = (
  node: DesignContextNode,
  colors: Map<string, ColorUsage>,
  styles: Map<string, StyleUsage>,
): void => {
  const styleIds = node.styleIds;
  addStyleRef(styles, styleIds?.fill, 'fill', node.id);
  addStyleRef(styles, styleIds?.stroke, 'stroke', node.id);
  addStyleRef(styles, styleIds?.effect, 'effect', node.id);
  addStyleRef(styles, styleIds?.text, 'text', node.id);

  collectPaints(
    colors,
    node.id,
    Array.isArray(node.fills) ? node.fills : undefined,
    'fills',
    styleIds?.fill,
  );
  collectPaints(colors, node.id, node.strokes, 'strokes', styleIds?.stroke);
  for (const effect of node.effects ?? []) {
    if (!effect.visible || effect.color === undefined) continue;
    addColor(colors, toHex(effect.color, effect.color.a), node.id, 'effects', styleIds?.effect);
  }

  for (const segment of node.segments ?? []) {
    addStyleRef(styles, segment.styleIds?.fill, 'fill', node.id);
    addStyleRef(styles, segment.styleIds?.text, 'text', node.id);
    collectSimplifiedPaints(colors, node.id, segment.fills, segment.styleIds?.fill);
  }
  for (const child of node.children ?? []) collectNodeGrounding(child, colors, styles);
};

const dedupeTokens = (tokens: readonly ProjectToken[]): ProjectToken[] => {
  const seen = new Set<string>();
  return tokens.filter(token => {
    const key = [
      token.name,
      token.value,
      token.cssVar ?? '',
      token.utility ?? '',
      token.scssVar ?? '',
      token.from ?? '',
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Read framework theme scales without importing or executing the project's config. The full
 * Figwright server and Kiwi use the same bounded static parser; runtime-only expressions stay
 * visible as a caveat instead of being guessed.
 */
const scanStaticTokenConfig = async (
  rootDir: string,
  profile: PortableProjectProfile,
): Promise<StaticConfigScan> => {
  const { configPath, system } = profile.styling;
  if (
    configPath === undefined ||
    !JS_CONFIG_EXTENSION.test(configPath) ||
    (system !== 'tailwind' && system !== 'unocss')
  ) {
    return { tokens: [], files: [], caveats: [] };
  }

  let body: string;
  try {
    body = await readFile(join(rootDir, configPath), 'utf8');
  } catch {
    return {
      tokens: [],
      files: [],
      caveats: [`The detected token config ${configPath} could not be read.`],
    };
  }

  let parsed;
  try {
    parsed =
      system === 'unocss'
        ? parseUnoConfig(configPath, body)
        : parseTailwindConfig(configPath, body);
  } catch {
    return {
      tokens: [],
      files: [configPath],
      caveats: [`The detected token config ${configPath} could not be parsed statically.`],
    };
  }

  const caveats = [
    'JavaScript and TypeScript token configs are parsed statically and never executed; runtime-only values are omitted.',
  ];
  if (!parsed.themeFound) {
    caveats.push(
      `${configPath} has no statically reachable theme object; its theme may be built at runtime or live in a preset or shared package.`,
    );
  }
  if (parsed.skipped > 0) {
    caveats.push(
      `${parsed.skipped} theme entr(ies) from ${configPath} were skipped because they use an imported spread, computed key, or function value.`,
    );
  }
  return { tokens: parsed.tokens, files: [configPath], caveats };
};

const tokenKey = (token: ProjectToken): string =>
  [
    token.name,
    token.value,
    token.cssVar ?? '',
    token.utility ?? '',
    token.scssVar ?? '',
    token.from ?? '',
  ].join('\u0000');

const candidateFrom = (
  token: ProjectToken,
  utilityFirst: boolean,
  dependencySource?: string,
): KiwiTokenCandidate => {
  const from = dependencySource ?? token.from;
  return {
    token: token.name,
    ref: refOf(token, utilityFirst),
    ...(token.cssVar === undefined ? {} : { cssVar: token.cssVar }),
    ...(token.utility === undefined ? {} : { utility: token.utility }),
    ...(from === undefined ? {} : { from }),
    confidence: 0.9,
    matchedBy: ['value'],
  };
};

/**
 * Join colors actually observed in the captured subtree to portable project tokens. Kiwi does not
 * expose variable or shared-style names, so this deliberately performs no name join.
 */
export const mapProjectTokens = async (input: {
  roots: readonly DesignContextNode[];
  rootDir: string;
  captureCaveats?: readonly string[];
  profile?: PortableProjectProfile;
  dependencyCatalog?: DependencyCatalog;
}): Promise<KiwiTokenMapResult> => {
  const rootDir = resolve(input.rootDir);
  const profile = input.profile ?? (await analyzePortableProject(rootDir));
  const [css, scss, config, dependencyCatalog] = await Promise.all([
    aggregateRepoCssTokens(rootDir),
    aggregateRepoScssTokens(rootDir),
    scanStaticTokenConfig(rootDir, profile),
    input.dependencyCatalog ?? buildDependencyCatalog(rootDir),
  ]);
  // A framework config and a generated CSS/SCSS mirror can carry the same semantic declaration.
  // Prefer the config's real utility reference for an identical name+value pair; different names or
  // values remain separate candidates, preserving genuine aliases and light/dark variants.
  const configDeclarations = new Set(
    config.tokens.map(token => `${token.name}\u0000${token.value}`),
  );
  const mirroredTokens = [...scss.tokens, ...css.tokens].filter(
    token => !configDeclarations.has(`${token.name}\u0000${token.value}`),
  );
  const localTokens = dedupeTokens([...config.tokens, ...mirroredTokens]);
  const localTokenKeys = new Set(localTokens.map(tokenKey));
  const dependencyTokens = dependencyCatalog.tokens.filter(
    item => !localTokenKeys.has(tokenKey(item.token)),
  );
  const dependencySourceByToken = new Map<string, string>();
  for (const dependency of dependencyTokens) {
    dependencySourceByToken.set(tokenKey(dependency.token), dependency.sourceImport);
  }
  const projectTokens = dedupeTokens([...localTokens, ...dependencyTokens.map(item => item.token)]);
  const utilityFirst = profile.styling.system === 'tailwind' || profile.styling.system === 'unocss';
  const projectByValue = new Map<string, ProjectToken[]>();
  for (const token of projectTokens) {
    const value = normHex(token.value);
    if (value === null) continue;
    const matches = projectByValue.get(value) ?? [];
    matches.push(token);
    projectByValue.set(value, matches);
  }

  const colors = new Map<string, ColorUsage>();
  const styles = new Map<string, StyleUsage>();
  for (const root of input.roots) collectNodeGrounding(root, colors, styles);

  const mappings: KiwiTokenMapping[] = [];
  for (const [value, usage] of [...colors].toSorted(([a], [b]) => compare(a, b))) {
    const matches = projectByValue.get(value) ?? [];
    const base = {
      figmaValue: value,
      figmaType: 'COLOR' as const,
      source: 'observed-value' as const,
      nodeIds: [...usage.nodeIds].toSorted(compare),
      properties: [...usage.properties].toSorted(compare),
      ...(usage.styleRefs.size === 0 ? {} : { styleRefs: [...usage.styleRefs].toSorted(compare) }),
    };
    if (matches.length === 1) {
      mappings.push({
        ...base,
        status: 'medium',
        candidate: candidateFrom(
          matches[0] as ProjectToken,
          utilityFirst,
          dependencySourceByToken.get(tokenKey(matches[0] as ProjectToken)),
        ),
      });
      continue;
    }
    if (matches.length > 1) {
      const ordered = matches.toSorted((a, b) => compare(a.name, b.name));
      mappings.push({
        ...base,
        status: 'ambiguous',
        candidateCount: matches.length,
        ...(matches.length > MAX_CANDIDATES
          ? {}
          : {
              candidates: ordered.map(token =>
                candidateFrom(token, utilityFirst, dependencySourceByToken.get(tokenKey(token))),
              ),
            }),
      });
      continue;
    }
    mappings.push({ ...base, status: 'unmapped' });
  }

  const unresolvedStyleRefs = [...styles]
    .toSorted(([a], [b]) => compare(a, b))
    .map(([id, usage]) => ({
      id,
      slots: [...usage.slots].toSorted(compare),
      nodeIds: [...usage.nodeIds].toSorted(compare),
    }));
  const omitted = css.omitted + scss.omitted;
  return {
    mappings,
    unmapped: mappings
      .filter(mapping => mapping.status === 'unmapped')
      .map(mapping => mapping.figmaValue),
    ambiguous: mappings
      .filter(mapping => mapping.status === 'ambiguous')
      .map(mapping => mapping.figmaValue),
    unresolvedStyleRefs,
    profile,
    projectTokenCount: projectTokens.length,
    localTokenCount: localTokens.length,
    dependencyTokenCount: dependencyTokens.length,
    dependencyPackages: [...new Set(dependencyTokens.map(item => item.sourceImport))].toSorted(
      compare,
    ),
    tokenFiles: [...new Set([...config.files, ...css.files, ...scss.files])].toSorted(compare),
    scanMode: SCAN_MODE,
    variableBindings: 'unavailable',
    caveats: [
      'Matches use exact color-value equality only. They are reuse candidates, not proven Figma variable bindings.',
      'Captured shared-style ids are opaque: Kiwi exposes stable ids but not their Figma names or definitions.',
      ...config.caveats,
      ...dependencyCatalog.caveats,
      ...(input.captureCaveats ?? []),
    ],
    ...(omitted === 0 ? {} : { truncationNote: truncationNote('stylesheet files', omitted) }),
  };
};
