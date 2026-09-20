import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type { DesignContextNode } from '@figwright/shared';

import { detectIconLibraries, scanRepoSvgs } from '../../mcp/src/icons/repo-icons.js';
import {
  collectFigmaComponents,
  type ComponentMapping,
  joinComponents,
  parseMapFile,
} from '../../mcp/src/join/component-map.js';
import { collectFigmaIcons, type IconMapping, joinIcons } from '../../mcp/src/join/icon-map.js';
import { analyzeProject, type ProjectProfile } from '../../mcp/src/profile/profile.js';
import { truncationNote, walkRepoFiles } from '../../mcp/src/repo-walk.js';
import type { ComponentFramework, ScannedComponent } from '../../mcp/src/scan/scan.js';
import { extractPortableReactComponents } from './portable-react-components.js';

const DEFAULT_THRESHOLD = 0.7;
const MAP_FILE = 'docs/figma-component-map.md';
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const PORTABLE_SCAN_MODE = 'portable-static-ast' as const;
const PORTABLE_SCAN_CAVEAT =
  'The standalone Kiwi bundle statically reads React component props with a pure JavaScript parser. ' +
  'Vue, Svelte and Angular prop coverage remains unknown, so unmatchedProps is not inferred for those scans.';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

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
  mappings: ComponentMapping[];
  unmapped: string[];
  profile: PortableProjectProfile;
  scannedComponentCount: number;
  scanMode: typeof PORTABLE_SCAN_MODE;
  caveats: string[];
  staleOverrides?: { figmaComponentName: string; name: string; filePath: string }[];
  truncationNote?: string;
}

export interface KiwiIconMapResult {
  mappings: IconMapping[];
  unmapped: string[];
  iconLibraries: string[];
  profile: PortableProjectProfile;
  svgFileCount: number;
  caveats: string[];
  truncationNote?: string;
}

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const readPackageJson = async (rootDir: string): Promise<PackageJson | null> => {
  try {
    return JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
};

const dependenciesOf = (value: PackageJson | null): Record<string, string> => ({
  ...value?.dependencies,
  ...value?.devDependencies,
});

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

export const mapProjectComponents = async (input: {
  roots: readonly DesignContextNode[];
  rootDir: string;
  threshold?: number;
  captureCaveats?: readonly string[];
  profile?: PortableProjectProfile;
}): Promise<KiwiComponentMapResult> => {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const [scan, overrideState] = await Promise.all([
    scanPortableComponents(input.rootDir, undefined, input.profile),
    readOverrides(resolve(input.rootDir)),
  ]);
  const mappings = joinComponents(collectFigmaComponents(input.roots), scan.components, {
    threshold,
    ...(overrideState.overrides.size === 0 ? {} : overrideState),
  });
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
    scannedComponentCount: scan.components.length,
    scanMode: PORTABLE_SCAN_MODE,
    caveats: [...scan.profile.caveats, ...(input.captureCaveats ?? [])],
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
}): Promise<KiwiIconMapResult> => {
  const rootDir = resolve(input.rootDir);
  const [profile, svgs, packageJson] = await Promise.all([
    input.profile ?? analyzePortableProject(rootDir),
    scanRepoSvgs(rootDir),
    readPackageJson(rootDir),
  ]);
  const mappings = joinIcons(collectFigmaIcons(input.roots), svgs.svgs, {
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
    svg: profile.svg,
    utilityFirst: profile.styling.system === 'tailwind' || profile.styling.system === 'unocss',
  });
  return {
    mappings,
    unmapped: mappings
      .filter(mapping => mapping.status === 'unmapped')
      .map(mapping => mapping.name),
    iconLibraries: detectIconLibraries(dependenciesOf(packageJson)),
    profile,
    svgFileCount: svgs.svgs.length,
    caveats: [...(input.captureCaveats ?? [])],
    ...(svgs.omitted === 0 ? {} : { truncationNote: truncationNote('.svg files', svgs.omitted) }),
  };
};
