import { describe, expect, it } from 'vitest';

import { extractPortableReactComponents } from '../src/portable-react-components.js';

describe('portable React component extraction', () => {
  it('reads local interface inheritance through wrapped reference exports', () => {
    const result = extractPortableReactComponents(
      'src/Button.tsx',
      `
        interface InteractiveProps { disabled?: boolean }
        interface ButtonProps extends InteractiveProps { size: 's' | 'm'; tone?: string }
        const Button = React.memo(({ size }: ButtonProps) => <button>{size}</button>);
        export { Button };
      `,
    );

    expect(result).toEqual([
      {
        name: 'Button',
        filePath: 'src/Button.tsx',
        exportKind: 'named',
        propNames: ['size', 'tone', 'disabled'],
        propsExtracted: true,
        framework: 'react',
      },
    ]);
  });

  it('reads FC annotations, class components and anonymous defaults', () => {
    expect(
      extractPortableReactComponents(
        'src/Card.tsx',
        `
          type CardProps = { elevated?: boolean } & { title: string };
          export const Card: React.FC<CardProps> = () => <article />;
          export class LegacyCard extends React.PureComponent<CardProps> {
            render() { return <article />; }
          }
        `,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'Card',
        propNames: ['elevated', 'title'],
        propsExtracted: true,
      }),
      expect.objectContaining({
        name: 'LegacyCard',
        propNames: ['elevated', 'title'],
        propsExtracted: true,
      }),
    ]);

    expect(
      extractPortableReactComponents(
        'src/StatusBadge.tsx',
        `export default ({ status }: { status: 'ok' | 'error' }) => <span>{status}</span>;`,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'StatusBadge',
        exportKind: 'default',
        propNames: ['status'],
        propsExtracted: true,
      }),
    ]);
  });

  it('keeps visible destructured props but marks imported contracts incomplete', () => {
    const result = extractPortableReactComponents(
      'src/Notice.tsx',
      `
        import type { NoticeProps } from './types';
        export function Notice({ tone, ...rest }: NoticeProps) {
          return <aside data-tone={tone} {...rest} />;
        }
      `,
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: 'Notice',
        propNames: ['tone'],
        propsExtracted: false,
      }),
    ]);

    expect(
      extractPortableReactComponents(
        'src/Chip.tsx',
        `
          import type { ChipProps } from './types';
          export const Chip: React.FC<ChipProps> = ({ tone }) => <span>{tone}</span>;
        `,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'Chip',
        propNames: ['tone'],
        propsExtracted: false,
      }),
    ]);
  });

  it('reads function-shaped component declarations from package type entrypoints', () => {
    expect(
      extractPortableReactComponents(
        '@fixture/ui',
        `
          export type IconProps = { name?: string; size?: number };
          export declare const Icon: ({ name, size }: IconProps) => JSX.Element | null;
          export declare const Registry: Record<string, unknown>;
        `,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'Icon',
        filePath: '@fixture/ui',
        exportKind: 'named',
        propNames: ['name', 'size'],
        propsExtracted: true,
      }),
    ]);
  });

  it('returns null for invalid syntax so the name-only fallback remains available', () => {
    expect(extractPortableReactComponents('src/Button.tsx', 'export const Button = <')).toBeNull();
  });
});
