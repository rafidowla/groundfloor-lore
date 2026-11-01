/**
 * arcadeRowFilter.ts — the client-side metadata AND-filter ArcadeVectorStore
 * applies to vector-neighbour and BM25 candidate rows (ArcadeDB's
 * vector.neighbors filter arg is version-sensitive, so the adapter filters
 * client-side). CONTRACT-DEVIATION (T3).
 *
 * Every filter key is exact equality against the row property of the same
 * name, except:
 *   - `security_scopes` / `contentHash` — handled separately, not a filter axis;
 *   - `tagsAll` (3.38.2) — ALL-of exact membership in the comma-joined `tags`
 *     property. Before this, an unknown key compared against an absent
 *     property and dropped EVERY row.
 */

import { TAGS_ALL_FILTER_KEY, delimitedListHas } from '../tagsAllFilter.js';

export function matchesArcadeRowFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (val === undefined || val === null || val === '') continue;
    if (key === 'security_scopes' || key === 'contentHash') continue;
    if (key === TAGS_ALL_FILTER_KEY) {
      if (!Array.isArray(val) || !val.every((t) => delimitedListHas(row['tags'], String(t)))) return false;
      continue;
    }
    if (String(row[key] ?? '') !== String(val)) return false;
  }
  return true;
}
