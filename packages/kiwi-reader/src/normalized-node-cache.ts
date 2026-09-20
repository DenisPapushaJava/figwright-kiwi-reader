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
  revision: number;
  normalized?: SerializedNode | null;
}

/**
 * Bounded cache for repeated reads from one capture session.
 *
 * Every entry records all scenegraph nodes used to build its captured subtree, including parents
 * and component masters outside that subtree. A later graph revision invalidates only entries whose
 * dependency set intersects the changed node or one of its ancestors.
 */
export class NormalizedNodeCache {
  private readonly entries = new Map<string, CachedNodeRead>();
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
    const key = `${nodeId}\u0000${maxDepth}\u0000${maxNodes}`;
    const cached = this.entries.get(key);
    if (
      cached !== undefined &&
      !graph.affectsDependenciesSince(cached.revision, cached.result.dependencies)
    ) {
      cached.revision = graph.revision;
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    if (cached !== undefined) {
      this.entries.delete(key);
      this.invalidations++;
    }

    this.misses++;
    const entry: CachedNodeRead = {
      result: graph.findWithStats(nodeId, maxDepth, maxNodes),
      revision: graph.revision,
    };
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
}
