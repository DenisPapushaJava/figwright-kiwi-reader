import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DesignContextNode } from '@figwright/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzePortableProject,
  mapProjectComponents,
  mapProjectIcons,
  scanPortableComponents,
} from '../src/project-grounding.js';
import { mapProjectTokens } from '../src/token-grounding.js';

const roots: string[] = [];

const projectFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'figwright-kiwi-grounding-'));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    mkdir(join(root, 'assets'), { recursive: true }),
    mkdir(join(root, 'docs'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^19.0.0', 'lucide-react': '^1.0.0' },
        devDependencies: {
          typescript: '^6.0.0',
          tailwindcss: '^4.0.0',
          'vite-plugin-svgr': '^4.0.0',
        },
      }),
      'utf8',
    ),
    writeFile(join(root, 'tsconfig.json'), '{}', 'utf8'),
    writeFile(
      join(root, 'src', 'Button.tsx'),
      `export const Button = ({ size }: { size: string }) => <button data-size={size} />;\n`,
      'utf8',
    ),
    writeFile(join(root, 'src', 'Ignored.tsx'), `export const Ignored = () => <div />;\n`, 'utf8'),
    writeFile(join(root, '.gitignore'), 'src/Ignored.tsx\n', 'utf8'),
    writeFile(
      join(root, 'assets', 'search.svg'),
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M1 1h2v2H1z"/></svg>',
      'utf8',
    ),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('portable Kiwi project grounding', () => {
  it('profiles and indexes exported React components with statically proven props', async () => {
    const rootDir = await projectFixture();

    const profile = await analyzePortableProject(rootDir);
    expect(profile).toMatchObject({
      framework: 'react',
      language: 'ts',
      styling: { system: 'tailwind', tailwindVersion: 4 },
      svg: { mode: 'component', loader: 'vite-plugin-svgr' },
      scanMode: 'portable-static-ast',
    });

    const scan = await scanPortableComponents(rootDir);
    expect(scan.components).toEqual([
      {
        name: 'Button',
        filePath: 'src/Button.tsx',
        exportKind: 'named',
        propNames: ['size'],
        propsExtracted: true,
        framework: 'react',
      },
    ]);
    expect(scan.profile.caveats.join(' ')).toContain('statically reads React component props');
  });

  it('reuses one verified project profile across combined grounding scans', async () => {
    const rootDir = await projectFixture();
    const profile = await analyzePortableProject(rootDir);
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.0.0' } }),
      'utf8',
    );

    const [components, icons, tokens] = await Promise.all([
      mapProjectComponents({ roots: [], rootDir, profile }),
      mapProjectIcons({ roots: [], rootDir, profile }),
      mapProjectTokens({ roots: [], rootDir, profile }),
    ]);

    expect(components.profile).toBe(profile);
    expect(icons.profile).toBe(profile);
    expect(tokens.profile).toBe(profile);
    expect(profile.framework).toBe('react');
  });

  it('maps Kiwi component instances and reports proven React prop coverage', async () => {
    const rootDir = await projectFixture();
    const design: DesignContextNode = {
      id: '1:1',
      name: 'Button / Primary',
      type: 'INSTANCE',
      mainComponent: {
        id: '2:2',
        key: 'button-key',
        name: 'Size=Large, State=Default',
        componentSetId: '2:1',
        componentSetName: 'Button',
      },
      componentProperties: {
        Size: { type: 'VARIANT', value: 'Large' },
        State: { type: 'VARIANT', value: 'Default' },
      },
    };

    const result = await mapProjectComponents({ roots: [design], rootDir });

    expect(result).toMatchObject({
      scannedComponentCount: 1,
      scanMode: 'portable-static-ast',
      unmapped: [],
      mappings: [
        {
          figmaComponentName: 'Button',
          mainComponentId: '2:1',
          variantAxes: ['Size', 'State'],
          status: 'high',
          candidate: {
            name: 'Button',
            filePath: 'src/Button.tsx',
            matchedProps: ['Size'],
            unmatchedProps: ['State'],
          },
        },
      ],
    });
  });

  it('honors a verified component map when Figma and project names differ', async () => {
    const rootDir = await projectFixture();
    await writeFile(
      join(rootDir, 'docs', 'figma-component-map.md'),
      '| Figma component | Project component |\n| --- | --- |\n| Primary action | src/Button.tsx |\n',
      'utf8',
    );
    const design: DesignContextNode = {
      id: '2:1',
      name: 'Primary action instance',
      type: 'INSTANCE',
      mainComponent: { id: '2:2', key: 'action-key', name: 'Primary action' },
    };

    const result = await mapProjectComponents({ roots: [design], rootDir });

    expect(result).toMatchObject({
      unmapped: [],
      mappings: [
        {
          figmaComponentName: 'Primary action',
          status: 'high',
          source: 'map-file',
          candidate: {
            name: 'Button',
            filePath: 'src/Button.tsx',
            confidence: 1,
          },
        },
      ],
    });
    expect(result.staleOverrides).toBeUndefined();
  });

  it('maps named Figma icons to strict project SVG matches and reports the import contract', async () => {
    const rootDir = await projectFixture();
    const design: DesignContextNode = {
      id: '3:1',
      name: 'Search icon instance',
      type: 'INSTANCE',
      mainComponent: { id: '3:2', key: 'search-key', name: 'Icons/Search' },
    };

    const result = await mapProjectIcons({ roots: [design], rootDir });

    expect(result).toMatchObject({
      unmapped: [],
      iconLibraries: ['lucide-react'],
      svgFileCount: 1,
      profile: { svg: { mode: 'component', loader: 'vite-plugin-svgr' } },
      mappings: [
        {
          name: 'Search',
          nodeIds: ['3:1'],
          status: 'high',
          candidate: {
            filePath: 'assets/search.svg',
            colorContract: 'currentColor',
            confidence: 1,
          },
        },
      ],
    });
    expect(result.mappings[0]?.candidate?.recolor).toContain('text-{token}');
  });

  it('maps observed colors to portable CSS and SCSS tokens without claiming Figma bindings', async () => {
    const rootDir = await projectFixture();
    await Promise.all([
      writeFile(
        join(rootDir, 'src', 'tokens.css'),
        `@theme { --color-brand: #6266f080; --color-text: #123456; }\n:root { --surface: #fff; --paper: #fff; --canvas: #fff; --white: #fff; }\n`,
        'utf8',
      ),
      writeFile(join(rootDir, 'src', '_tokens.scss'), '$shadow: #00000066;\n', 'utf8'),
      writeFile(join(rootDir, 'src', 'ignored.css'), ':root { --ignored: #abcdef; }\n', 'utf8'),
      writeFile(join(rootDir, '.gitignore'), 'src/Ignored.tsx\nsrc/ignored.css\n', 'utf8'),
    ]);
    const design: DesignContextNode = {
      id: '4:1',
      name: 'Card',
      type: 'FRAME',
      styleIds: { fill: 'S:fill', effect: 'S:effect' },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          opacity: 0.5,
          color: { r: 0x62 / 255, g: 0x66 / 255, b: 0xf0 / 255 },
        },
      ],
      effects: [
        {
          type: 'DROP_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.4 },
        },
      ],
      children: [
        {
          id: '4:2',
          name: 'Gradient',
          type: 'RECTANGLE',
          fills: [
            {
              type: 'GRADIENT_LINEAR',
              visible: true,
              opacity: 1,
              gradientStops: [
                { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
                { position: 1, color: { r: 0xab / 255, g: 0xcd / 255, b: 0xef / 255, a: 1 } },
              ],
              gradientTransform: [
                [1, 0, 0],
                [0, 1, 0],
              ],
            },
          ],
        },
        {
          id: '4:3',
          name: 'Mixed text',
          type: 'TEXT',
          segments: [
            {
              characters: 'Hello',
              start: 0,
              end: 5,
              fontName: { family: 'Inter', style: 'Regular' },
              fontSize: 16,
              fills: [{ type: 'SOLID', color: '#123456' }],
              textDecoration: 'NONE',
              textCase: 'ORIGINAL',
              styleIds: { fill: 'S:text-fill', text: 'S:text' },
            },
          ],
        },
      ],
    };

    const result = await mapProjectTokens({ roots: [design], rootDir });

    expect(result).toMatchObject({
      scanMode: 'portable-css-scss-js-config',
      variableBindings: 'unavailable',
      unresolvedStyleRefs: [
        { id: 'S:effect', slots: ['effect'], nodeIds: ['4:1'] },
        { id: 'S:fill', slots: ['fill'], nodeIds: ['4:1'] },
        { id: 'S:text', slots: ['text'], nodeIds: ['4:3'] },
        { id: 'S:text-fill', slots: ['fill'], nodeIds: ['4:3'] },
      ],
    });
    expect(result.tokenFiles).toEqual(['src/_tokens.scss', 'src/tokens.css']);
    expect(result.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          figmaValue: '#6266F080',
          properties: ['fills'],
          styleRefs: ['S:fill'],
          status: 'medium',
          candidate: expect.objectContaining({
            token: 'color-brand',
            ref: 'brand',
            matchedBy: ['value'],
          }),
        }),
        expect.objectContaining({
          figmaValue: '#00000066',
          properties: ['effects'],
          status: 'medium',
          candidate: expect.objectContaining({
            token: 'shadow',
            ref: '$shadow',
            from: 'src/_tokens.scss',
          }),
        }),
        expect.objectContaining({
          figmaValue: '#123456',
          properties: ['segments.fills'],
          styleRefs: ['S:text-fill'],
          status: 'medium',
          candidate: expect.objectContaining({ token: 'color-text', ref: 'text' }),
        }),
        expect.objectContaining({
          figmaValue: '#FFFFFF',
          properties: ['fills.gradientStops'],
          status: 'ambiguous',
          candidateCount: 4,
        }),
        expect.objectContaining({ figmaValue: '#ABCDEF', status: 'unmapped' }),
      ]),
    );
    expect(
      result.mappings.find(mapping => mapping.figmaValue === '#FFFFFF')?.candidates,
    ).toBeUndefined();
    expect(result.unmapped).toContain('#ABCDEF');
    expect(result.caveats.join(' ')).toContain('value equality only');
  });

  it('maps Tailwind config colors with the shared static parser and reports runtime values', async () => {
    const rootDir = await projectFixture();
    await Promise.all([
      writeFile(
        join(rootDir, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^19.0.0' },
          devDependencies: { tailwindcss: '^3.4.0', typescript: '^6.0.0' },
        }),
        'utf8',
      ),
      writeFile(
        join(rootDir, 'tailwind.config.ts'),
        `export default { theme: { extend: { colors: { brand: '#123456', runtime: makeColor() } } } };\n`,
        'utf8',
      ),
      writeFile(join(rootDir, 'src', 'tokens.css'), '@theme { --color-brand: #123456; }\n', 'utf8'),
    ]);
    const design: DesignContextNode = {
      id: '5:1',
      name: 'Brand surface',
      type: 'RECTANGLE',
      fills: [
        {
          type: 'SOLID',
          visible: true,
          opacity: 1,
          color: { r: 0x12 / 255, g: 0x34 / 255, b: 0x56 / 255 },
        },
      ],
    };

    const result = await mapProjectTokens({ roots: [design], rootDir });

    expect(result.profile.styling).toMatchObject({
      system: 'tailwind',
      configPath: 'tailwind.config.ts',
      tailwindVersion: 3,
    });
    expect(result.tokenFiles).toEqual(['src/tokens.css', 'tailwind.config.ts']);
    expect(result.projectTokenCount).toBe(1);
    expect(result.mappings).toContainEqual(
      expect.objectContaining({
        figmaValue: '#123456',
        status: 'medium',
        candidate: expect.objectContaining({
          token: 'color-brand',
          ref: 'brand',
          utility: 'brand',
        }),
      }),
    );
    expect(result.caveats.join(' ')).toContain('never executed');
    expect(result.caveats.join(' ')).toContain('1 theme entr(ies)');
  });

  it('detects UnoCSS mts configs and keeps CSS and SCSS tokens alongside config tokens', async () => {
    const rootDir = await projectFixture();
    await Promise.all([
      writeFile(
        join(rootDir, 'package.json'),
        JSON.stringify({ dependencies: { vue: '^3.0.0' }, devDependencies: { unocss: '^66.0.0' } }),
        'utf8',
      ),
      writeFile(
        join(rootDir, 'uno.config.mts'),
        `import { defineConfig, presetUno } from 'unocss';\nexport default defineConfig({ presets: [presetUno()], theme: { colors: { accent: '#abcdef' } } });\n`,
        'utf8',
      ),
      writeFile(join(rootDir, 'src', 'tokens.css'), ':root { --surface: #123456; }\n', 'utf8'),
      writeFile(join(rootDir, 'src', '_tokens.scss'), '$shadow: #00000066;\n', 'utf8'),
    ]);
    const design: DesignContextNode = {
      id: '6:1',
      name: 'Accent surface',
      type: 'RECTANGLE',
      fills: [
        {
          type: 'SOLID',
          visible: true,
          opacity: 1,
          color: { r: 0xab / 255, g: 0xcd / 255, b: 0xef / 255 },
        },
      ],
    };

    const result = await mapProjectTokens({ roots: [design], rootDir });

    expect(result.profile.styling).toMatchObject({
      system: 'unocss',
      configPath: 'uno.config.mts',
    });
    expect(result.tokenFiles).toEqual(['src/_tokens.scss', 'src/tokens.css', 'uno.config.mts']);
    expect(result.projectTokenCount).toBe(3);
    expect(result.mappings).toContainEqual(
      expect.objectContaining({
        figmaValue: '#ABCDEF',
        status: 'medium',
        candidate: expect.objectContaining({
          token: 'color-accent',
          ref: 'accent',
          utility: 'accent',
        }),
      }),
    );
  });
});
