import type { SerializedNode } from '@figwright/shared';

import { normalizeCapturedNode } from './normalize.js';
import type { SceneGraphFindResult, SceneGraphStore } from './scenegraph.js';

const DEFAULT_MAX_ENTRIES = 8;

export interface NormalizedNodeCacheStats {
  entries: number;
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
  normalizations: number;
}

export interface CachedNodeRead {
  readonly result: SceneGraphFindResult;
  normalized?: SerializedNode | null;
}

/**
 * Bounded cache for repeated reads from one capture session.
 *
 * A scenegraph revision invalidates every entry. This is deliberately conservative: component
 * instances can depend on masters outside the requested subtree, so keeping entries across an
 * arbitrary graph update would risk returning stale expanded instances.
 */
export class NormalizedNodeCache {
  private readonly entries = new Map<string, CachedNodeRead>();
  private revision: number | null = null;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;
  private evictions = 0;
  private normalizations = 0;

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Normalized node cache must retain at least one entry');
    }
  }

  read(graph: SceneGraphStore, nodeId: string, maxDepth: number, maxNodes: number): CachedNodeRead {
    this.prepareRevision(graph.revision);
    const key = `${nodeId}\u0000${maxDepth}\u0000${maxNodes}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    this.misses++;
    const entry: CachedNodeRead = { result: graph.findWithStats(nodeId, maxDepth, maxNodes) };
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.evictions++;
      }
    }
    return entry;
  }

  normalize(entry: CachedNodeRead): SerializedNode | null {
    if (entry.normalized !== undefined) return entry.normalized;
    this.normalizations++;
    entry.normalized = entry.result.node === null ? null : normalizeCapturedNode(entry.result.node);
    return entry.normalized;
  }

  get stats(): NormalizedNodeCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      evictions: this.evictions,
      normalizations: this.normalizations,
    };
  }

  private prepareRevision(revision: number): void {
    if (this.revision === revision) return;
    if (this.revision !== null && this.entries.size > 0) this.invalidations++;
    this.entries.clear();
    this.revision = revision;
  }
}
