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
import type { ProjectProfile } from '../../mcp/src/profile/profile.js';
import { truncationNote, walkRepoFiles } from '../../mcp/src/repo-walk.js';
import type { ComponentFramework, ScannedComponent } from '../../mcp/src/scan/scan.js';

const DEFAULT_THRESHOLD = 0.7;
const MAP_FILE = 'docs/figma-component-map.md';
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const PORTABLE_SCAN_MODE = 'portable-name-only' as const;
const PORTABLE_SCAN_CAVEAT =
  'The standalone Kiwi bundle verifies component exports and names without a native AST parser. ' +
  'Prop coverage is intentionally unknown, so unmatchedProps is never inferred from this scan.';

type Framework = ProjectProfile['framework'];

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

const COMPONENT_EXTENSIONS: Record<Framework, string[]> = {
  next: ['.tsx', '.jsx'],
  nuxt: ['.vue'],
  react: ['.tsx', '.jsx'],
  vue: ['.vue'],
  svelte: ['.svelte'],
  solid: ['.tsx', '.jsx'],
  angular: ['.ts'],
  unknown: ['.tsx', '.jsx', '.vue', '.svelte'],
};

const SVG_LOADERS: Array<{ dep: string; loader: string; hint: string }> = [
  {
    dep: 'vite-plugin-svgr',
    loader: 'vite-plugin-svgr',
    hint: "import Icon from './icon.svg?react'",
  },
  {
    dep: 'vite-svg-loader',
    loader: 'vite-svg-loader',
    hint: "import Icon from './icon.svg?component'",
  },
  {
    dep: 'vite-plugin-solid-svg',
    loader: 'vite-plugin-solid-svg',
    hint: "import Icon from './icon.svg?component-solid'",
  },
  {
    dep: '@svgr/webpack',
    loader: '@svgr/webpack',
    hint: "import { ReactComponent as Icon } from './icon.svg'",
  },
  { dep: '@svgr/rollup', loader: '@svgr/rollup', hint: "import Icon from './icon.svg'" },
  {
    dep: 'unplugin-icons',
    loader: 'unplugin-icons',
    hint: "import Icon from '~icons/{collection}/{name}' (local svg via FileSystemIconLoader)",
  },
  {
    dep: 'nuxt-svgo',
    loader: 'nuxt-svgo',
    hint: "import Icon from './icon.svg?component' (or <NuxtIcon>)",
  },
  {
    dep: 'nuxt-svgo-loader',
    loader: 'nuxt-svgo-loader',
    hint: "import Icon from './icon.svg?component' (or a <SvgoIcon name> macro)",
  },
  { dep: '@nuxtjs/svg', loader: '@nuxtjs/svg', hint: "import Icon from './icon.svg?component'" },
];

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

const detectFramework = (deps: Record<string, string>): Framework => {
  if ('next' in deps) return 'next';
  if ('nuxt' in deps) return 'nuxt';
  if ('react' in deps) return 'react';
  if ('vue' in deps) return 'vue';
  if ('svelte' in deps) return 'svelte';
  if ('solid-js' in deps) return 'solid';
  if ('@angular/core' in deps) return 'angular';
  return 'unknown';
};

const majorVersion = (range: string | undefined): number | undefined => {
  const match = range?.match(/\d+/);
  return match === undefined || match === null ? undefined : Number(match[0]);
};

const detectStyling = async (
  rootDir: string,
  deps: Record<string, string>,
): Promise<ProjectProfile['styling']> => {
  const tailwindConfigs = [
    'tailwind.config.js',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
    'tailwind.config.ts',
  ];
  const tailwindConfigPresence = await Promise.all(
    tailwindConfigs.map(configPath => fileExists(join(rootDir, configPath))),
  );
  const tailwindConfig = tailwindConfigs.find((_, index) => tailwindConfigPresence[index] === true);
  if (tailwindConfig !== undefined) {
    return {
      system: 'tailwind',
      configPath: tailwindConfig,
      tailwindVersion: majorVersion(deps.tailwindcss) ?? 3,
    };
  }
  if ('tailwindcss' in deps || '@tailwindcss/vite' in deps || '@tailwindcss/postcss' in deps) {
    return { system: 'tailwind', tailwindVersion: majorVersion(deps.tailwindcss) ?? 4 };
  }
  if (Object.keys(deps).some(name => name === 'unocss' || name.startsWith('@unocss/'))) {
    return { system: 'unocss' };
  }
  if (['sass', 'sass-embedded', 'node-sass'].some(name => name in deps)) {
    return { system: 'scss' };
  }
  const cssWalk = await walkRepoFiles(rootDir, { extensions: ['.css'], cap: 200 });
  for (const path of cssWalk.files) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan; first signal wins
      const body = await readFile(join(rootDir, path), 'utf8');
      if (/\.module\.css$/i.test(path)) return { system: 'css-modules' };
      if (/--[\w-]+\s*:/.test(body)) return { system: 'css-variables' };
    } catch {
      // Ignore a file that disappeared during the scan.
    }
  }
  return { system: cssWalk.files.length > 0 ? 'plain-css' : 'unknown' };
};

const detectSvg = (deps: Record<string, string>): ProjectProfile['svg'] => {
  const match = SVG_LOADERS.find(item => item.dep in deps);
  return match === undefined
    ? { mode: 'url' }
    : { mode: 'component', loader: match.loader, importHint: match.hint };
};

export const analyzePortableProject = async (rootDir: string): Promise<PortableProjectProfile> => {
  const root = resolve(rootDir);
  const packageJson = await readPackageJson(root);
  const deps = dependenciesOf(packageJson);
  const framework = detectFramework(deps);
  const language =
    (await fileExists(join(root, 'tsconfig.json'))) || 'typescript' in deps ? 'ts' : 'js';
  const styling = await detectStyling(root, deps);
  const svg = detectSvg(deps);
  return {
    rootDir: root,
    framework,
    language,
    styling,
    svg,
    componentExtensions: COMPONENT_EXTENSIONS[framework],
    evidence: [
      `framework=${framework}: dependency manifest`,
      `language=${language}: ${language === 'ts' ? 'TypeScript signal present' : 'no TypeScript signal'}`,
      `styling=${styling.system}: portable manifest/config scan`,
      `svg=${svg.mode}${svg.loader === undefined ? '' : ` (${svg.loader})`}: dependency manifest`,
    ],
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
): Promise<PortableComponentScan> => {
  const profile = await analyzePortableProject(rootDir);
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
}): Promise<KiwiComponentMapResult> => {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const [scan, overrideState] = await Promise.all([
    scanPortableComponents(input.rootDir),
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
}): Promise<KiwiIconMapResult> => {
  const rootDir = resolve(input.rootDir);
  const [profile, svgs, packageJson] = await Promise.all([
    analyzePortableProject(rootDir),
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
