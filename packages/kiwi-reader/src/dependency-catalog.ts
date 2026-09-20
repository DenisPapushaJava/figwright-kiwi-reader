import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { parse } from '@babel/parser';

import { classifySvgColor, type SvgColorContract } from '../../mcp/src/icons/repo-icons.js';
import { walkRepoFiles } from '../../mcp/src/repo-walk.js';
import type { ScannedComponent } from '../../mcp/src/scan/scan.js';
import { parseScssFile } from '../../mcp/src/tokens/scss-file.js';
import { parseCssCustomProperties, type ProjectToken } from '../../mcp/src/tokens/tokens.js';
import { extractPortableReactComponents } from './portable-react-components.js';

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'] as const;
const PACKAGE_CODE_EXTENSIONS = new Set(SOURCE_EXTENSIONS);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_FILES = 500;
const MAX_TYPE_FILES = 100;
const MAX_STYLE_FILES = 100;

type AstNode = Record<string, any>;

interface PackageJson {
  name?: string;
  types?: string;
  typings?: string;
  style?: string;
  sass?: string;
  exports?: unknown;
}

interface ImportBinding {
  packageName: string;
  specifier: string;
  importedName: string;
  exportKind: 'default' | 'named';
}

interface ComponentEvidence extends ImportBinding {
  propNames: Set<string>;
  literalProps: Map<string, Set<string>>;
}

export interface DependencyComponent {
  component: ScannedComponent;
  packageName: string;
  importPath: string;
  importName: string;
  exportKind: 'default' | 'named';
  /** True when project source actually renders this package export in JSX. */
  observed: boolean;
}

export interface DependencyIcon {
  name: string;
  value: string;
  packageName: string;
  importPath: string;
  componentName: string;
  propName: string;
  colorContract: SvgColorContract;
}

export interface DependencyToken {
  token: ProjectToken;
  /** The public package specifier that makes the token available to the project. */
  sourceImport: string;
}

export interface DependencyCatalog {
  components: DependencyComponent[];
  icons: DependencyIcon[];
  tokens: DependencyToken[];
  packages: string[];
  sourceFilesScanned: number;
  packageFilesScanned: number;
  omittedPackageFiles: number;
  caveats: string[];
}

interface SourceEvidence {
  components: Map<string, ComponentEvidence>;
  styleImports: Set<string>;
  sourceFilesScanned: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isBareSpecifier = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('.') &&
  !value.startsWith('/') &&
  !value.startsWith('#') &&
  !value.startsWith('node:');

export const packageNameOf = (specifier: string): string | null => {
  if (!isBareSpecifier(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@')
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : null
    : (parts[0] ?? null);
};

const parseProgram = (filePath: string, body: string): AstNode | null => {
  try {
    return parse(body, {
      sourceFilename: filePath,
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes', 'estree'],
    }).program as unknown as AstNode;
  } catch {
    return null;
  }
};

const stringValue = (node: AstNode | null | undefined): string | null => {
  if (node?.type === 'Literal' || node?.type === 'StringLiteral') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (node?.type === 'JSXExpressionContainer') return stringValue(node.expression);
  if (node?.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0) {
    return node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw ?? null;
  }
  return null;
};

const importedNameOf = (specifier: AstNode): string | null => {
  const value = specifier.imported?.name ?? specifier.imported?.value;
  return typeof value === 'string' ? value : null;
};

const walkAst = (root: AstNode, visit: (node: AstNode) => void): void => {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const value = node as AstNode;
    if (typeof value.type === 'string') visit(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const item of child) walk(item);
      else walk(child);
    }
  };
  walk(root);
};

const sourceEvidence = async (rootDir: string): Promise<SourceEvidence> => {
  const components = new Map<string, ComponentEvidence>();
  const styleImports = new Set<string>();
  const walk = await walkRepoFiles(rootDir, { extensions: SOURCE_EXTENSIONS });
  let sourceFilesScanned = 0;

  for (const relativePath of walk.files) {
    let body: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan
      const info = await stat(join(rootDir, relativePath));
      if (info.size > MAX_SOURCE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan
      body = await readFile(join(rootDir, relativePath), 'utf8');
    } catch {
      continue;
    }
    const program = parseProgram(relativePath, body);
    if (program === null) continue;
    sourceFilesScanned += 1;

    const bindings = new Map<string, ImportBinding>();
    for (const node of program.body ?? []) {
      if (node.type !== 'ImportDeclaration') continue;
      const specifier = stringValue(node.source);
      if (specifier === null || !isBareSpecifier(specifier)) continue;
      styleImports.add(specifier);
      const packageName = packageNameOf(specifier);
      if (packageName === null || node.importKind === 'type') continue;
      for (const imported of node.specifiers ?? []) {
        if (imported.importKind === 'type') continue;
        const local = imported.local?.name;
        if (typeof local !== 'string') continue;
        if (imported.type === 'ImportDefaultSpecifier') {
          bindings.set(local, {
            packageName,
            specifier,
            importedName: local,
            exportKind: 'default',
          });
        } else if (imported.type === 'ImportSpecifier') {
          const importedName = importedNameOf(imported);
          if (importedName !== null) {
            bindings.set(local, { packageName, specifier, importedName, exportKind: 'named' });
          }
        } else if (imported.type === 'ImportNamespaceSpecifier') {
          bindings.set(local, {
            packageName,
            specifier,
            importedName: '*',
            exportKind: 'named',
          });
        }
      }
    }

    walkAst(program, node => {
      if (node.type !== 'JSXOpeningElement') return;
      const tag = node.name;
      let binding: ImportBinding | undefined;
      if (tag?.type === 'JSXIdentifier') binding = bindings.get(tag.name);
      else if (tag?.type === 'JSXMemberExpression' && tag.object?.type === 'JSXIdentifier') {
        const namespace = bindings.get(tag.object.name);
        const member = tag.property?.name;
        if (namespace?.importedName === '*' && typeof member === 'string') {
          binding = { ...namespace, importedName: member };
        }
      }
      if (binding === undefined || binding.importedName === '*') return;
      const key = `${binding.specifier}\u0000${binding.importedName}`;
      const evidence = components.get(key) ?? {
        ...binding,
        propNames: new Set<string>(),
        literalProps: new Map<string, Set<string>>(),
      };
      for (const attribute of node.attributes ?? []) {
        if (attribute.type !== 'JSXAttribute') continue;
        const propName = attribute.name?.name;
        if (typeof propName !== 'string') continue;
        evidence.propNames.add(propName);
        const literal = stringValue(attribute.value);
        if (literal !== null) {
          const values = evidence.literalProps.get(propName) ?? new Set<string>();
          values.add(literal);
          evidence.literalProps.set(propName, values);
        }
      }
      components.set(key, evidence);
    });
  }

  const styleWalk = await walkRepoFiles(rootDir, { extensions: ['.css', '.scss'] });
  for (const relativePath of styleWalk.files) {
    let body: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan
      const info = await stat(join(rootDir, relativePath));
      if (info.size > MAX_SOURCE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded deterministic scan
      body = await readFile(join(rootDir, relativePath), 'utf8');
    } catch {
      continue;
    }
    sourceFilesScanned += 1;
    for (const match of body.matchAll(
      /@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/gi,
    )) {
      const specifier = match[1];
      if (specifier !== undefined && isBareSpecifier(specifier)) styleImports.add(specifier);
    }
  }

  return { components, styleImports, sourceFilesScanned };
};

const safePackagePath = (packageDir: string, value: string): string | null => {
  if (value.length === 0 || value.includes('\0')) return null;
  const target = resolve(packageDir, value);
  const base = resolve(packageDir);
  return target === base || target.startsWith(`${base}${sep}`) ? target : null;
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const packageDirectory = (rootDir: string, packageName: string): string =>
  join(rootDir, 'node_modules', ...packageName.split('/'));

const replaceWildcard = (value: unknown, replacement: string): unknown => {
  if (typeof value === 'string') return value.replaceAll('*', replacement);
  if (Array.isArray(value)) return value.map(item => replaceWildcard(item, replacement));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      replaceWildcard(item, replacement),
    ]),
  );
};

const exportTarget = (manifest: PackageJson, specifier: string, packageName: string): unknown => {
  const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`;
  const exports = manifest.exports;
  if (exports === null || exports === undefined) return undefined;
  if (typeof exports === 'string' || Array.isArray(exports))
    return subpath === '.' ? exports : undefined;
  if (typeof exports !== 'object') return undefined;
  const record = exports as Record<string, unknown>;
  if (Object.keys(record).some(key => key.startsWith('.'))) {
    if (record[subpath] !== undefined) return record[subpath];
    for (const key of Object.keys(record).toSorted(compare)) {
      if (!key.includes('*')) continue;
      const [prefix, suffix = ''] = key.split('*');
      if (!subpath.startsWith(prefix ?? '') || !subpath.endsWith(suffix)) continue;
      const replacement = subpath.slice((prefix ?? '').length, subpath.length - suffix.length);
      return replaceWildcard(record[key], replacement);
    }
    return undefined;
  }
  return subpath === '.' ? record : undefined;
};

const targetStrings = (value: unknown, preferredKeys: readonly string[]): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => targetStrings(item, preferredKeys));
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const ordered = [
    ...preferredKeys,
    ...Object.keys(record)
      .filter(key => !preferredKeys.includes(key))
      .toSorted(compare),
  ];
  return ordered.flatMap(key => targetStrings(record[key], preferredKeys));
};

const firstReadable = async (paths: readonly string[]): Promise<string | null> => {
  for (const path of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop -- short ordered candidate list
      const info = await stat(path);
      if (info.isFile() && info.size <= MAX_SOURCE_BYTES) return path;
    } catch {
      // Try the next public entrypoint candidate.
    }
  }
  return null;
};

const typeEntry = async (
  packageDir: string,
  manifest: PackageJson,
  specifier: string,
  packageName: string,
): Promise<string | null> => {
  const candidates = targetStrings(exportTarget(manifest, specifier, packageName), [
    'types',
    'typings',
    'import',
    'default',
  ])
    .filter(value => /\.d\.[cm]?ts$/i.test(value))
    .map(value => safePackagePath(packageDir, value))
    .filter((value): value is string => value !== null);
  if (specifier === packageName) {
    for (const value of [manifest.types, manifest.typings]) {
      if (value !== undefined) {
        const path = safePackagePath(packageDir, value);
        if (path !== null) candidates.push(path);
      }
    }
  } else {
    const subpath = specifier.slice(packageName.length + 1);
    for (const suffix of ['.d.ts', '/index.d.ts']) {
      const path = safePackagePath(packageDir, `${subpath}${suffix}`);
      if (path !== null) candidates.push(path);
    }
  }
  return firstReadable(candidates);
};

const typeModuleEntry = async (
  packageDir: string,
  from: string,
  request: string,
): Promise<string | null> => {
  if (!request.startsWith('.')) return null;
  const base = safePackagePath(
    packageDir,
    join(relative(packageDir, resolve(from, '..')), request),
  );
  if (base === null) return null;
  const withoutJs = base.replace(/\.[cm]?js$/i, '');
  return firstReadable([
    base,
    `${base}.d.ts`,
    `${withoutJs}.d.ts`,
    join(base, 'index.d.ts'),
    join(withoutJs, 'index.d.ts'),
  ]);
};

const componentsFromTypeGraph = async (
  packageDir: string,
  entry: string,
  publicSpecifier: string,
): Promise<ScannedComponent[]> => {
  const queue = [entry];
  const seen = new Set<string>();
  const components = new Map<string, ScannedComponent>();
  while (queue.length > 0 && seen.size < MAX_TYPE_FILES) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    let body: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded declaration graph
      const info = await stat(path);
      if (info.size > MAX_SOURCE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded declaration graph
      body = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const sourceName = relative(packageDir, path).replaceAll('\\', '/');
    for (const component of extractPortableReactComponents(sourceName, body) ?? []) {
      if (!components.has(component.name)) {
        components.set(component.name, { ...component, filePath: publicSpecifier });
      }
    }
    for (const match of body.matchAll(
      /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    )) {
      const request = match[1];
      if (request === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded declaration graph
      const child = await typeModuleEntry(packageDir, path, request);
      if (child !== null && !seen.has(child)) queue.push(child);
    }
  }
  return [...components.values()];
};

const mergeComponents = (
  evidence: SourceEvidence,
  declarations: readonly DependencyComponent[],
): DependencyComponent[] => {
  const merged = new Map<string, DependencyComponent>();
  for (const declaration of declarations) {
    merged.set(`${declaration.importPath}\u0000${declaration.component.name}`, declaration);
  }
  for (const observed of evidence.components.values()) {
    const key = `${observed.specifier}\u0000${observed.importedName}`;
    const declared = merged.get(key);
    const propNames = new Set(declared?.component.propNames ?? []);
    for (const prop of observed.propNames) propNames.add(prop);
    merged.set(key, {
      packageName: observed.packageName,
      importPath: observed.specifier,
      importName: observed.importedName,
      exportKind: observed.exportKind,
      observed: true,
      component: {
        name: observed.importedName,
        filePath: observed.specifier,
        exportKind: observed.exportKind,
        propNames: [...propNames].toSorted(compare),
        // JSX usage proves listed props but cannot prove the list is exhaustive.
        propsExtracted: declared?.component.propsExtracted === true,
        framework: 'react',
      },
    });
  }
  return [...merged.values()].toSorted((a, b) =>
    compare(`${a.importPath}\u0000${a.component.name}`, `${b.importPath}\u0000${b.component.name}`),
  );
};

interface PackageWalk {
  files: string[];
  omitted: number;
}

const walkPackageFiles = async (
  packageDir: string,
  extensions: ReadonlySet<string>,
  cap = MAX_PACKAGE_FILES,
): Promise<PackageWalk> => {
  const files: string[] = [];
  let omitted = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
        compare(a.name, b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.endsWith('.map')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- deterministic bounded walk
        await visit(path);
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        if (files.length < cap) files.push(path);
        else omitted += 1;
      }
    }
  };
  await visit(packageDir);
  return { files, omitted };
};

const iconControls = (evidence: SourceEvidence): ComponentEvidence[] =>
  [...evidence.components.values()].filter(component =>
    [...component.literalProps].some(
      ([prop, values]) =>
        /icon|glyph|symbol/i.test(component.importedName) ||
        /icon|glyph|symbol/i.test(prop) ||
        [...values].some(value => value.includes('/')),
    ),
  );

const iconName = (value: string): string => {
  const clean = value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\.svg$/i, '');
  return clean.split('/').at(-1) ?? clean;
};

type IconConvention = 'path' | 'last-two' | 'basename';

const valueFor = (asset: string, convention: IconConvention): string => {
  const clean = asset
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\.svg$/i, '');
  const parts = clean.split('/').filter(Boolean);
  if (convention === 'basename') return parts.at(-1) ?? clean;
  if (convention === 'last-two') return parts.slice(-2).join('/');
  return clean;
};

const inferConvention = (
  assets: readonly string[],
  observed: ReadonlySet<string>,
): IconConvention | null => {
  const conventions: IconConvention[] = ['path', 'last-two', 'basename'];
  let best: { convention: IconConvention; coverage: number } | null = null;
  for (const convention of conventions) {
    const values = new Set(assets.map(asset => valueFor(asset, convention)));
    const coverage = [...observed].filter(value => values.has(value)).length;
    if (coverage > 0 && (best === null || coverage > best.coverage))
      best = { convention, coverage };
  }
  return best?.convention ?? null;
};

const scanPackageIcons = async (
  packageDir: string,
  controls: readonly ComponentEvidence[],
): Promise<{ icons: DependencyIcon[]; files: number; omitted: number }> => {
  if (controls.length === 0) return { icons: [], files: 0, omitted: 0 };
  const walk = await walkPackageFiles(packageDir, PACKAGE_CODE_EXTENSIONS);
  const bodies = new Map<string, string>();
  const assetsByFile = new Map<string, Set<string>>();
  for (const path of walk.files) {
    let body: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded package scan
      const info = await stat(path);
      if (info.size > MAX_SOURCE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded package scan
      body = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(packageDir, path).replaceAll('\\', '/');
    bodies.set(rel, body);
    const assets = new Set<string>();
    for (const match of body.matchAll(/["'`]((?:\.?\.?\/)?[^"'`\r\n]+\.svg)["'`]/g)) {
      if (match[1] !== undefined) assets.add(match[1]);
    }
    if (assets.size > 0) assetsByFile.set(rel, assets);
  }
  const out: DependencyIcon[] = [];
  for (const control of controls) {
    for (const [propName, observed] of control.literalProps) {
      for (const assets of assetsByFile.values()) {
        const assetList = [...assets].toSorted(compare);
        const convention = inferConvention(assetList, observed);
        if (convention === null) continue;
        for (const asset of assetList) {
          const value = valueFor(asset, convention);
          const matchingBody = [...bodies].find(([path]) =>
            path.toLowerCase().endsWith(`${asset.replace(/^\.\//, '')}.js`.toLowerCase()),
          )?.[1];
          out.push({
            name: iconName(value),
            value,
            packageName: control.packageName,
            importPath: control.specifier,
            componentName: control.importedName,
            propName,
            colorContract: matchingBody === undefined ? 'unknown' : classifySvgColor(matchingBody),
          });
        }
      }
    }
  }
  const seen = new Set<string>();
  return {
    icons: out
      .filter(icon => {
        const key = [icon.importPath, icon.componentName, icon.propName, icon.value].join('\u0000');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .toSorted((a, b) => compare(a.value, b.value)),
    files: bodies.size,
    omitted: walk.omitted,
  };
};

const styleEntries = async (
  packageDir: string,
  manifest: PackageJson,
  specifier: string,
  packageName: string,
): Promise<string[]> => {
  const targets = targetStrings(exportTarget(manifest, specifier, packageName), [
    'style',
    'sass',
    'default',
    'import',
  ]).filter(value => /\.(?:css|scss)$/i.test(value));
  if (specifier === packageName) {
    if (manifest.style !== undefined) targets.push(manifest.style);
    if (manifest.sass !== undefined) targets.push(manifest.sass);
  }
  const directSubpath = specifier.slice(packageName.length + 1);
  if (/\.(?:css|scss)$/i.test(directSubpath)) targets.push(directSubpath);
  const paths = targets
    .map(value => safePackagePath(packageDir, value))
    .filter((value): value is string => value !== null);
  const readable: string[] = [];
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop -- short public-entrypoint list
    if ((await firstReadable([path])) !== null) readable.push(path);
  }
  return [...new Set(readable)];
};

const styleModuleEntry = async (
  packageDir: string,
  from: string,
  request: string,
): Promise<string | null> => {
  if (!request.startsWith('.')) return null;
  const cleanRequest = request.split(/[?#]/, 1)[0];
  if (cleanRequest === undefined || cleanRequest.length === 0) return null;
  const base = safePackagePath(
    packageDir,
    join(relative(packageDir, resolve(from, '..')), cleanRequest),
  );
  if (base === null) return null;
  const directory = resolve(base, '..');
  const name = base.slice(directory.length + 1);
  return firstReadable([
    base,
    `${base}.css`,
    `${base}.scss`,
    join(directory, `_${name}.scss`),
    join(base, 'index.css'),
    join(base, 'index.scss'),
    join(base, '_index.scss'),
  ]);
};

const tokensFromStyleGraph = async (
  packageDir: string,
  entry: string,
  sourceImport: string,
): Promise<DependencyToken[]> => {
  const queue = [entry];
  const seen = new Set<string>();
  const tokens: DependencyToken[] = [];
  while (queue.length > 0 && seen.size < MAX_STYLE_FILES) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    let body: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded public stylesheet graph
      const info = await stat(path);
      if (info.size > MAX_SOURCE_BYTES) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded public stylesheet graph
      body = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const parsed =
      extname(path).toLowerCase() === '.scss'
        ? parseScssFile(body, sourceImport)
        : parseCssCustomProperties(body);
    tokens.push(...parsed.map(token => ({ token, sourceImport })));
    for (const match of body.matchAll(
      /@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/gi,
    )) {
      const request = match[1];
      if (request === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded public stylesheet graph
      const child = await styleModuleEntry(packageDir, path, request);
      if (child !== null && !seen.has(child)) queue.push(child);
    }
  }
  return tokens;
};

/**
 * Build a project-specific catalog of installed dependency UI. Discovery is driven by the project's
 * own imports and JSX, then restricted to public package entrypoints plus a bounded static asset
 * scan. Dependency JavaScript is read as text and is never imported or executed.
 */
export const buildDependencyCatalog = async (rootDir: string): Promise<DependencyCatalog> => {
  const absoluteRoot = resolve(rootDir);
  const evidence = await sourceEvidence(absoluteRoot);
  const specifiers = new Set<string>([
    ...[...evidence.components.values()].map(value => value.specifier),
    ...evidence.styleImports,
  ]);
  const packageNames = new Set(
    [...specifiers].map(packageNameOf).filter((value): value is string => value !== null),
  );
  const manifests = new Map<string, { directory: string; manifest: PackageJson }>();
  for (const packageName of [...packageNames].toSorted(compare)) {
    const directory = packageDirectory(absoluteRoot, packageName);
    // eslint-disable-next-line no-await-in-loop -- direct dependency list, deterministic
    const manifest = await readJson<PackageJson>(join(directory, 'package.json'));
    if (manifest !== null) manifests.set(packageName, { directory, manifest });
  }

  const declarations: DependencyComponent[] = [];
  const componentSpecifiers = new Set(
    [...evidence.components.values()].map(component => component.specifier),
  );
  for (const specifier of [...componentSpecifiers].toSorted(compare)) {
    const packageName = packageNameOf(specifier);
    const installed = packageName === null ? undefined : manifests.get(packageName);
    if (packageName === null || installed === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- direct public entrypoint list
    const entry = await typeEntry(installed.directory, installed.manifest, specifier, packageName);
    if (entry === null) continue;
    // eslint-disable-next-line no-await-in-loop -- bounded public declaration graph
    const parsed = await componentsFromTypeGraph(installed.directory, entry, specifier);
    for (const component of parsed) {
      declarations.push({
        component: { ...component, filePath: specifier },
        packageName,
        importPath: specifier,
        importName: component.name,
        exportKind: component.exportKind,
        observed: false,
      });
    }
  }

  const icons: DependencyIcon[] = [];
  let packageFilesScanned = 0;
  let omittedPackageFiles = 0;
  const controlsByPackage = new Map<string, ComponentEvidence[]>();
  for (const control of iconControls(evidence)) {
    const controls = controlsByPackage.get(control.packageName) ?? [];
    controls.push(control);
    controlsByPackage.set(control.packageName, controls);
  }
  for (const [packageName, controls] of controlsByPackage) {
    const installed = manifests.get(packageName);
    if (installed === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- bounded per-package scan
    const scanned = await scanPackageIcons(installed.directory, controls);
    icons.push(...scanned.icons);
    packageFilesScanned += scanned.files;
    omittedPackageFiles += scanned.omitted;
  }

  const tokens: DependencyToken[] = [];
  const tokenFiles = new Set<string>();
  for (const specifier of [...evidence.styleImports].toSorted(compare)) {
    const packageName = packageNameOf(specifier);
    const installed = packageName === null ? undefined : manifests.get(packageName);
    if (packageName === null || installed === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- direct public style entrypoint list
    const entries = await styleEntries(
      installed.directory,
      installed.manifest,
      specifier,
      packageName,
    );
    for (const entry of entries) {
      const key = `${specifier}\u0000${entry}`;
      if (tokenFiles.has(key)) continue;
      tokenFiles.add(key);
      // eslint-disable-next-line no-await-in-loop -- bounded public stylesheet graph
      tokens.push(...(await tokensFromStyleGraph(installed.directory, entry, specifier)));
    }
  }

  const components = mergeComponents(evidence, declarations);
  const installedPackages = [...manifests.keys()].toSorted(compare);
  return {
    components,
    icons,
    tokens,
    packages: installedPackages,
    sourceFilesScanned: evidence.sourceFilesScanned,
    packageFilesScanned,
    omittedPackageFiles,
    caveats:
      installedPackages.length === 0
        ? []
        : [
            'Installed dependency grounding is inferred statically from project imports, JSX usage, package metadata, declaration files, and styles; dependency code is never executed.',
            ...(omittedPackageFiles === 0
              ? []
              : [`${omittedPackageFiles} dependency asset file(s) exceeded the bounded scan.`]),
          ],
  };
};
