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
  it('profiles and indexes exported components without claiming unproven props', async () => {
    const rootDir = await projectFixture();

    const profile = await analyzePortableProject(rootDir);
    expect(profile).toMatchObject({
      framework: 'react',
      language: 'ts',
      styling: { system: 'tailwind', tailwindVersion: 4 },
      svg: { mode: 'component', loader: 'vite-plugin-svgr' },
      scanMode: 'portable-name-only',
    });

    const scan = await scanPortableComponents(rootDir);
    expect(scan.components).toEqual([
      {
        name: 'Button',
        filePath: 'src/Button.tsx',
        exportKind: 'named',
        propNames: [],
        propsExtracted: false,
        framework: 'react',
      },
    ]);
    expect(scan.profile.caveats.join(' ')).toContain('Prop coverage is intentionally unknown');
  });

  it('maps Kiwi component instances to project components without inventing prop gaps', async () => {
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
      scanMode: 'portable-name-only',
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
            matchedProps: [],
            unmatchedProps: [],
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
});
