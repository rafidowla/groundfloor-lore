/**
 * analytics/layerViolations.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * User-declared LayerSpec rule check — pre-configured ui/core/plugins layers.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Detects edges that violate user-declared layer rules. A LayerSpec
 * declares which paths belong to which layer + which directions are
 * allowed:
 *
 *   layers:
 *     ui:      ['ui/**']
 *     core:    ['packages/lore/**']
 *     plugins: ['packages/lore-plugin-*\/**']
 *   allowed:
 *     ui      → core
 *     plugins → core
 *   denied:
 *     ui      ⇏ plugins
 *     core    ⇏ plugins        # core stays plugin-agnostic
 *
 * Edges that match a denied rule (or any rule not in the allowed set)
 * become Violations. The default LayerSpec for Lore ships in
 * defaultLoreLayerSpec().
 */

import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface LayerSpec {
    /** layerName → glob-like path patterns. Patterns use `**` for any
     *  number of dirs and `*` for one path component. */
    layers: Record<string, string[]>;
    /** Edges from→to that ARE permitted. */
    allowed: Array<{ from: string; to: string }>;
}

export interface LayerViolation {
    sourceId: string;
    targetId: string;
    sourceLayer: string;
    targetLayer: string;
    kind: string;  // edge kind that violated
    reason: string;
}

/**
 * Pattern → regex. `**` matches any number of path segments; `*`
 * matches a single segment.
 */
function patternToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLE__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE__/g, '.*');
    return new RegExp('^' + escaped + '$');
}

function layerOf(filePath: string, spec: LayerSpec): string | null {
    for (const [layer, patterns] of Object.entries(spec.layers)) {
        for (const pattern of patterns) {
            if (patternToRegex(pattern).test(filePath)) return layer;
        }
    }
    return null;
}

export function defaultLoreLayerSpec(): LayerSpec {
    return {
        layers: {
            ui:      ['ui/**'],
            core:    ['packages/lore/**'],
            plugins: ['packages/lore-plugin-*/**'],
        },
        allowed: [
            { from: 'ui',      to: 'core'    },
            { from: 'plugins', to: 'core'    },
            { from: 'ui',      to: 'ui'      },
            { from: 'core',    to: 'core'    },
            { from: 'plugins', to: 'plugins' },
        ],
    };
}

export function layerViolations(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    spec: LayerSpec = defaultLoreLayerSpec(),
    options: { edgeKinds?: ReadonlySet<string> } = {},
): LayerViolation[] {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);

    const allowedSet = new Set(spec.allowed.map((a) => `${a.from}→${a.to}`));
    const violations: LayerViolation[] = [];

    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        const sourceSym = rel.sourceId.startsWith('file:')
            ? null
            : table.byId.get(rel.sourceId);
        const targetSym = table.byId.get(rel.targetId);
        if (!targetSym) continue;

        const sourcePath = sourceSym?.file ?? rel.sourceId.replace(/^file:/, '');
        const targetPath = targetSym.file;

        const sourceLayer = layerOf(sourcePath, spec);
        const targetLayer = layerOf(targetPath, spec);
        if (!sourceLayer || !targetLayer) continue;
        if (sourceLayer === targetLayer) continue; // intra-layer edges are fine

        if (!allowedSet.has(`${sourceLayer}→${targetLayer}`)) {
            violations.push({
                sourceId: rel.sourceId,
                targetId: rel.targetId,
                sourceLayer,
                targetLayer,
                kind: rel.kind,
                reason: `${sourceLayer} → ${targetLayer} not in LayerSpec.allowed`,
            });
        }
    }

    return violations;
}
