import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type { DesignContextNode } from '@figwright/shared';

import { scanRepoSvgs, type SvgColorContract } from '../../mcp/src/icons/repo-icons.js';
import { casefold } from '../../mcp/src/join/casefold.js';
import {
  collectFigmaComponents,
  type ComponentMapping,
  joinComponents,
  parseMapFile,
} from '../../mcp/src/join/component-map.js';
import {
  collectFigmaIcons,
  iconLabel,
  type IconMapping,
  joinIcons,
} from '../../mcp/src/join/icon-map.js';
import { analyzeProject, type ProjectProfile } from '../../mcp/src/profile/profile.js';
import { truncationNote, walkRepoFiles } from '../../mcp/src/repo-walk.js';
import type { ComponentFramework, ScannedComponent } from '../../mcp/src/scan/scan.js';
import {
  buildDependencyCatalog,
  type DependencyCatalog,
  type DependencyIcon,
} from './dependency-catalog.js';
import { extractPortableReactComponents } from './portable-react-components.js';

const DEFAULT_THRESHOLD = 0.7;
const MAP_FILE = 'docs/figma-component-map.md';
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const PORTABLE_SCAN_MODE = 'portable-static-ast' as const;
const PORTABLE_SCAN_CAVEAT =
  'The standalone Kiwi bundle statically reads React component props with a pure JavaScript parser. ' +
  'Vue, Svelte and Angular prop coverage remains unknown, so unmatchedProps is not inferred for those scans.';

export type KiwiComponentMapping = Omit<ComponentMapping, 'candidate'> & {
  candidate?: NonNullable<ComponentMapping['candidate']> & {
    origin?: 'dependency';
    import?: { from: string; kind: 'default' | 'named'; name: string };
  };
};

export interface DependencyIconCandidate {
  kind: 'dependency-registry';
  packageName: string;
  import: { from: string; name: string; props: Record<string, string> };
  colorContract: SvgColorContract;
  recolor: string;
  confidence: number;
}

export interface DependencyComponentIconCandidate {
  kind: 'dependency-component';
  packageName: string;
  import: { from: string; kind: 'default' | 'named'; name: string };
  colorContract: 'unknown';
  recolor: string;
  confidence: number;
}

export type KiwiIconMapping = Omit<IconMapping, 'candidate'> & {
  candidate?: IconMapping['candidate'] | DependencyIconCandidate | DependencyComponentIconCandidate;
};

export interface PortableProjectProfile extends ProjectProfile {
  scanMode: typeof PORTABLE_SCAN_MODE;
  caveats: string[];
}

export interface PortableComponentScan {
  components: ScannedComponent[];
  omitted: number;
  profile: PortableProjectProfile;
}

export interface KiwiComponentMapResult {
  mappings: KiwiComponentMapping[];
  unmapped: string[];
  profile: PortableProjectProfile;
  scannedComponentCount: number;
  localComponentCount: number;
  dependencyComponentCount: number;
  dependencyPackages: string[];
  scanMode: typeof PORTABLE_SCAN_MODE;
  caveats: string[];
  staleOverrides?: { figmaComponentName: string; name: string; filePath: string }[];
  truncationNote?: string;
}

export interface KiwiIconMapResult {
  mappings: KiwiIconMapping[];
  unmapped: string[];
  iconLibraries: string[];
  profile: PortableProjectProfile;
  svgFileCount: number;
  dependencyIconCount: number;
  dependencyPackages: string[];
  caveats: string[];
  truncationNote?: string;
}

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export const analyzePortableProject = async (rootDir: string): Promise<PortableProjectProfile> => {
  const profile = await analyzeProject(rootDir);
  return {
    ...profile,
    scanMode: PORTABLE_SCAN_MODE,
    caveats: [PORTABLE_SCAN_CAVEAT],
  };
};

const pascalName = (filePath: string): string => {
  let base = basename(filePath, extname(filePath));
  if (base.toLowerCase() === 'index') base = basename(dirname(filePath));
  return base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
};

const isPascalCase = (value: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(value);
const hasJsx = (body: string): boolean =>
  /(?:return|=>)\s*\(?\s*(?:<[A-Za-z]|<>)/m.test(body) || /React\.createElement\s*\(/.test(body);

const exportedBindings = (body: string): Set<string> => {
  const declarations = new Set<string>();
  for (const match of body.matchAll(/\bfunction\s+([A-Z][A-Za-z0-9]*)\b/g)) {
    if (match[1] !== undefined) declarations.add(match[1]);
  }
  for (const match of body.matchAll(
    /\bclass\s+([A-Z][A-Za-z0-9]*)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/g,
  )) {
    if (match[1] !== undefined) declarations.add(match[1]);
  }
  for (const match of body.matchAll(
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9]*)\b[^=;\n]*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:memo|forwardRef|observer)\s*\()/g,
  )) {
    if (match[1] !== undefined) declarations.add(match[1]);
  }
  const exported = new Set<string>();
  for (const match of body.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Z][A-Za-z0-9]*)\b/g,
  )) {
    if (match[1] !== undefined && declarations.has(match[1])) exported.add(match[1]);
  }
  for (const match of body.matchAll(/\bexport\s+default\s+([A-Z][A-Za-z0-9]*)\b/g)) {
    if (match[1] !== undefined && declarations.has(match[1])) exported.add(match[1]);
  }
  for (const match of body.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const local = part
        .trim()
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (local !== undefined && declarations.has(local) && isPascalCase(local))
        exported.add(local);
    }
  }
  return exported;
};

const componentFramework = (extension: string): ComponentFramework | null => {
  if (extension === '.tsx' || extension === '.jsx') return 'react';
  if (extension === '.vue') return 'vue';
  if (extension === '.svelte') return 'svelte';
  if (extension === '.ts') return 'angular';
  return null;
};

const portableComponentsIn = (
  filePath: string,
  body: string,
  framework: ComponentFramework,
): ScannedComponent[] => {
  const base = {
    filePath,
    propNames: [] as string[],
    propsExtracted: false,
    framework,
  };
  if (framework === 'vue') {
    return /<template\b/i.test(body)
      ? [{ ...base, name: pascalName(filePath), exportKind: 'default' }]
      : [];
  }
  if (framework === 'svelte') {
    return /<svelte:|<[A-Za-z][^>]*>/.test(body)
      ? [{ ...base, name: pascalName(filePath), exportKind: 'default' }]
      : [];
  }
  if (framework === 'angular') {
    const match = /@Component\s*\([\s\S]*?\)\s*export\s+class\s+([A-Z][A-Za-z0-9]*)\b/.exec(body);
    return match?.[1] === undefined ? [] : [{ ...base, name: match[1], exportKind: 'named' }];
  }
  const parsed = extractPortableReactComponents(filePath, body);
  if (parsed !== null) return parsed;
  if (!hasJsx(body)) return [];
  const fileName = pascalName(filePath);
  const names = new Set([...exportedBindings(body)].filter(name => name === fileName));
  if (names.size === 0 && /\bexport\s+default\s+(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/.test(body)) {
    const name = pascalName(filePath);
    if (isPascalCase(name)) names.add(name);
  }
  const components: ScannedComponent[] = [];
  for (const name of names) {
    components.push({
      ...base,
      name,
      exportKind: new RegExp(
        `\\bexport\\s+default\\s+(?:(?:async\\s+)?(?:function|class)\\s+)?${name}\\b`,
      ).test(body)
        ? 'default'
        : 'named',
    });
  }
  return components;
};

export const scanPortableComponents = async (
  rootDir: string,
  extensions?: readonly string[],
  knownProfile?: PortableProjectProfile,
): Promise<PortableComponentScan> => {
  const profile = knownProfile ?? (await analyzePortableProject(rootDir));
  const selectedExtensions = extensions ?? profile.componentExtensions;
  const walk = await walkRepoFiles(profile.rootDir, { extensions: selectedExtensions });
  const components: ScannedComponent[] = [];
  for (const relativePath of walk.files) {
    const framework = componentFramework(extname(relativePath).toLowerCase());
    if (framework === null) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan; one bad file is skipped
      const info = await stat(join(profile.rootDir, relativePath));
      if (info.size > MAX_SOURCE_FILE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- see above
      const body = await readFile(join(profile.rootDir, relativePath), 'utf8');
      components.push(...portableComponentsIn(relativePath, body, framework));
    } catch {
      // The file may disappear while a developer rebuilds; the remaining index stays valid.
    }
  }
  return { components, omitted: walk.omitted, profile };
};

const readOverrides = async (
  rootDir: string,
): Promise<{
  overrides: ReturnType<typeof parseMapFile>;
  overridesOnDisk: Set<string>;
}> => {
  let overrides: ReturnType<typeof parseMapFile>;
  try {
    overrides = parseMapFile(await readFile(join(rootDir, MAP_FILE), 'utf8'));
  } catch {
    return { overrides: new Map(), overridesOnDisk: new Set() };
  }
  const present = new Set<string>();
  await Promise.all(
    [...new Set([...overrides.values()].map(item => item.filePath))].map(async path => {
      if (await fileExists(join(rootDir, path))) present.add(path);
    }),
  );
  const overridesOnDisk = new Set<string>();
  for (const [key, value] of overrides) {
    if (present.has(value.filePath)) overridesOnDisk.add(key);
  }
  return { overrides, overridesOnDisk };
};

const iconPathKey = (value: string): string => {
  const parts = value
    .split('/')
    .map(part => casefold(part))
    .filter(Boolean);
  if (/^icons?$/.test(parts[0] ?? '')) parts[0] = 'icons';
  return parts.join('/');
};

const dependencyIconMatch = (
  label: string,
  figmaName: string,
  icons: readonly DependencyIcon[],
): DependencyIcon | null => {
  const exact = icons.filter(icon => iconPathKey(icon.value) === iconPathKey(figmaName));
  if (exact.length === 1) return exact[0] ?? null;
  const byLabel = icons.filter(
    icon =>
      casefold(icon.name) === casefold(label) ||
      casefold(iconLabel(icon.value)) === casefold(label),
  );
  // Reusing the wrong icon is worse than exporting a fresh one. A basename that occurs in several
  // registry folders stays unmapped unless Figma carried the folder and selected it above.
  return byLabel.length === 1 ? (byLabel[0] ?? null) : null;
};

const dependencyIconRecolor = (contract: SvgColorContract): string => {
  if (contract === 'currentColor') {
    return 'recolorable through the dependency component color/currentColor contract; mirror an existing project usage';
  }
  if (contract === 'fixed') return 'fixed color in the dependency asset; render as-is';
  if (contract === 'multi-color') return 'multi-color dependency asset; render as-is';
  return 'dependency asset color contract is unknown; inspect an existing project usage before recoloring';
};

const dependencyIconCandidate = (icon: DependencyIcon): DependencyIconCandidate => ({
  kind: 'dependency-registry',
  packageName: icon.packageName,
  import: {
    from: icon.importPath,
    name: icon.componentName,
    props: { [icon.propName]: icon.value },
  },
  colorContract: icon.colorContract,
  recolor: dependencyIconRecolor(icon.colorContract),
  confidence: 1,
});

const dependencyComponentIconMatch = (
  label: string,
  catalog: DependencyCatalog,
): DependencyCatalog['components'][number] | null => {
  let matches = catalog.components.filter(
    item => casefold(item.component.name) === casefold(label),
  );
  if (matches.some(item => item.observed)) matches = matches.filter(item => item.observed);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const dependencyComponentIconCandidate = (
  component: DependencyCatalog['components'][number],
): DependencyComponentIconCandidate => ({
  kind: 'dependency-component',
  packageName: component.packageName,
  import: {
    from: component.importPath,
    kind: component.exportKind,
    name: component.importName,
  },
  colorContract: 'unknown',
  recolor:
    'component color contract is unknown; mirror an existing project usage before recoloring',
  confidence: 0.9,
});

export const mapProjectComponents = async (input: {
  roots: readonly DesignContextNode[];
  rootDir: string;
  threshold?: number;
  captureCaveats?: readonly string[];
  profile?: PortableProjectProfile;
  dependencyCatalog?: DependencyCatalog;
}): Promise<KiwiComponentMapResult> => {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const [scan, overrideState, dependencyCatalog] = await Promise.all([
    scanPortableComponents(input.rootDir, undefined, input.profile),
    readOverrides(resolve(input.rootDir)),
    input.dependencyCatalog ?? buildDependencyCatalog(input.rootDir),
  ]);
  const observedDependencyNames = new Set(
    dependencyCatalog.components
      .filter(item => item.observed)
      .map(item => casefold(item.component.name)),
  );
  const dependencyComponents = dependencyCatalog.components
    .filter(item => !observedDependencyNames.has(casefold(item.component.name)) || item.observed)
    .map(item => item.component);
  const rawMappings = joinComponents(
    collectFigmaComponents(input.roots),
    [...scan.components, ...dependencyComponents],
    {
      threshold,
      ...(overrideState.overrides.size === 0 ? {} : overrideState),
    },
  );
  const dependencyByCandidate = new Map(
    dependencyCatalog.components.map(item => [
      `${item.component.filePath}\u0000${item.component.name}`,
      item,
    ]),
  );
  const mappings = rawMappings as KiwiComponentMapping[];
  for (const mapping of mappings) {
    if (mapping.candidate === undefined) continue;
    const dependency = dependencyByCandidate.get(
      `${mapping.candidate.filePath}\u0000${mapping.candidate.name}`,
    );
    if (dependency === undefined) continue;
    Object.assign(mapping.candidate, {
      origin: 'dependency' as const,
      import: {
        from: dependency.importPath,
        kind: dependency.exportKind,
        name: dependency.importName,
      },
    });
  }
  const staleOverrides = mappings.flatMap(mapping =>
    mapping.staleOverride === undefined
      ? []
      : [{ figmaComponentName: mapping.figmaComponentName, ...mapping.staleOverride }],
  );
  return {
    mappings,
    unmapped: mappings
      .filter(mapping => mapping.status === 'unmapped')
      .map(mapping => mapping.figmaComponentName),
    profile: scan.profile,
    scannedComponentCount: scan.components.length + dependencyComponents.length,
    localComponentCount: scan.components.length,
    dependencyComponentCount: dependencyComponents.length,
    dependencyPackages: [
      ...new Set(dependencyCatalog.components.map(item => item.packageName)),
    ].toSorted(),
    scanMode: PORTABLE_SCAN_MODE,
    caveats: [
      ...scan.profile.caveats,
      ...dependencyCatalog.caveats,
      ...(input.captureCaveats ?? []),
    ],
    ...(staleOverrides.length === 0 ? {} : { staleOverrides }),
    ...(scan.omitted === 0 ? {} : { truncationNote: truncationNote('source files', scan.omitted) }),
  };
};

export const mapProjectIcons = async (input: {
  roots: readonly DesignContextNode[];
  rootDir: string;
  threshold?: number;
  captureCaveats?: readonly string[];
  profile?: PortableProjectProfile;
  dependencyCatalog?: DependencyCatalog;
}): Promise<KiwiIconMapResult> => {
  const rootDir = resolve(input.rootDir);
  const [profile, svgs, dependencyCatalog] = await Promise.all([
    input.profile ?? analyzePortableProject(rootDir),
    scanRepoSvgs(rootDir),
    input.dependencyCatalog ?? buildDependencyCatalog(rootDir),
  ]);
  const figmaIcons = collectFigmaIcons(input.roots);
  const localMappings = joinIcons(figmaIcons, svgs.svgs, {
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    svg: profile.svg,
    utilityFirst: profile.styling.system === 'tailwind' || profile.styling.system === 'unocss',
  });
  const mappings = localMappings as KiwiIconMapping[];
  for (const [index, mapping] of mappings.entries()) {
    if (mapping.status !== 'unmapped') continue;
    const usage = figmaIcons[index];
    if (usage === undefined) continue;
    const dependency = dependencyIconMatch(usage.name, usage.figmaName, dependencyCatalog.icons);
    if (dependency !== null) {
      Object.assign(mapping, {
        status: 'high',
        candidate: dependencyIconCandidate(dependency),
      });
      continue;
    }
    const component = dependencyComponentIconMatch(usage.name, dependencyCatalog);
    if (component === null) continue;
    Object.assign(mapping, {
      status: 'medium',
      candidate: dependencyComponentIconCandidate(component),
    });
  }
  const mappedDependencyPackages = mappings.flatMap(mapping => {
    const candidate = mapping.candidate;
    return candidate !== undefined && 'packageName' in candidate ? [candidate.packageName] : [];
  });
  const dependencyPackages = [
    ...new Set([
      ...dependencyCatalog.icons.map(icon => icon.packageName),
      ...mappedDependencyPackages,
    ]),
  ].toSorted();
  return {
    mappings,
    unmapped: mappings
      .filter(mapping => mapping.status === 'unmapped')
      .map(mapping => mapping.name),
    iconLibraries: dependencyPackages,
    profile,
    svgFileCount: svgs.svgs.length,
    dependencyIconCount: dependencyCatalog.icons.length,
    dependencyPackages,
    caveats: [...dependencyCatalog.caveats, ...(input.captureCaveats ?? [])],
    ...(svgs.omitted === 0 ? {} : { truncationNote: truncationNote('.svg files', svgs.omitted) }),
  };
};
