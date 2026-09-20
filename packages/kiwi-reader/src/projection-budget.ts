import type { DetailLevel } from '@figwright/shared';

import type { CapturedNode } from './scenegraph.js';

const FIXED_NODE_BYTES: Readonly<Record<DetailLevel, number>> = {
  minimal: Buffer.byteLength('{"id":,"name":,"type":}', 'utf8'),
  compact: Buffer.byteLength('{"id":,"name":,"type":,"x":0,"y":0,"width":0,"height":0}', 'utf8'),
  full: Buffer.byteLength('{"id":,"name":,"type":,"x":0,"y":0,"width":0,"height":0}', 'utf8'),
};

const cachedMinimums = new WeakMap<CapturedNode, Partial<Record<DetailLevel, number>>>();

const jsonStringBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Return a strict lower bound for the projected node tree's serialized UTF-8 size.
 *
 * The estimate counts only fields emitted for every node at the requested detail level. It omits
 * children-array punctuation and all optional properties, and represents every number as the
 * shortest valid JSON number. Exceeding a response budget is therefore sufficient proof that the
 * real projection cannot fit; staying below the budget makes no claim and uses the exact path.
 */
export const minimumProjectedNodeBytes = (root: CapturedNode, detail: DetailLevel): number => {
  const cached = cachedMinimums.get(root)?.[detail];
  if (cached !== undefined) return cached;

  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as CapturedNode;
    bytes +=
      FIXED_NODE_BYTES[detail] +
      jsonStringBytes(node.id) +
      jsonStringBytes(node.name) +
      jsonStringBytes(node.type);
    for (const child of node.children) pending.push(child);
  }

  const minimums = cachedMinimums.get(root) ?? {};
  minimums[detail] = bytes;
  cachedMinimums.set(root, minimums);
  return bytes;
};
