/**
 * test/workspace-id-unit.ts
 *
 * Unit tests for packages/lore/src/util/workspaceId.ts.
 *
 * Why these matter:
 *   Per C-6 (locked V3 prep), the workspace identifier rule is shared
 *   between Lore (TypeScript) and Loom (Python). Both implementations
 *   must produce identical results for the same inputs, or the
 *   integration breaks silently. This file is the canonical TypeScript
 *   test suite; DEF mirrors with the same cases in Python.
 *
 * Run: npx tsx test/workspace-id-unit.ts
 */

import * as assert from 'node:assert/strict';

import {
    isValidWorkspaceId,
    suggestWorkspaceId,
    assertValidWorkspaceId,
    WorkspaceIdValidationError,
    getReservedWorkspaceNames,
    getMaxWorkspaceIdLength,
} from '../packages/lore/src/util/workspaceId.js';

// ── isValidWorkspaceId ─────────────────────────────────────────────────────

function testIsValidWorkspaceId(): void {
    // Happy path
    assert.equal(isValidWorkspaceId('mira'), true, 'simple lowercase name');
    assert.equal(isValidWorkspaceId('personal'), true, 'word');
    assert.equal(isValidWorkspaceId('my-portfolio-1'), true, 'hyphens + digit');
    assert.equal(isValidWorkspaceId('team_alpha'), true, 'underscore mid-name');
    assert.equal(isValidWorkspaceId('abc123'), true, 'mixed letters and digits');
    assert.equal(isValidWorkspaceId('1mira'), true, 'starts with digit');
    assert.equal(isValidWorkspaceId('a'), true, 'single character');
    assert.equal(isValidWorkspaceId('a'.repeat(40)), true, 'max length');

    // Empty / wrong type
    assert.equal(isValidWorkspaceId(''), false, 'empty string');
    assert.equal(isValidWorkspaceId(null as unknown as string), false, 'null');
    assert.equal(isValidWorkspaceId(undefined as unknown as string), false, 'undefined');
    assert.equal(isValidWorkspaceId(42 as unknown as string), false, 'number');

    // Length
    assert.equal(isValidWorkspaceId('a'.repeat(41)), false, 'too long (41)');
    assert.equal(isValidWorkspaceId('a'.repeat(100)), false, 'much too long');

    // Bad start char
    assert.equal(isValidWorkspaceId('-mira'), false, 'starts with hyphen');
    assert.equal(isValidWorkspaceId('_mira'), false, 'starts with underscore');

    // Invalid characters
    assert.equal(isValidWorkspaceId('Mira'), false, 'uppercase');
    assert.equal(isValidWorkspaceId('mira workspace'), false, 'space');
    assert.equal(isValidWorkspaceId("mira's"), false, 'apostrophe');
    assert.equal(isValidWorkspaceId('mira/personal'), false, 'slash');
    assert.equal(isValidWorkspaceId('mira.dev'), false, 'period');
    assert.equal(isValidWorkspaceId('ñ'), false, 'non-ASCII');
    assert.equal(isValidWorkspaceId('mira!'), false, 'punctuation');

    // Reserved
    assert.equal(isValidWorkspaceId('default'), false, 'reserved: default');
    assert.equal(isValidWorkspaceId('system'), false, 'reserved: system');
    assert.equal(isValidWorkspaceId('lore'), false, 'reserved: lore');
    assert.equal(isValidWorkspaceId('loom'), false, 'reserved: loom');
    assert.equal(isValidWorkspaceId('admin'), false, 'reserved: admin');

    console.log('  ✓ isValidWorkspaceId — all rules enforced');
}

// ── assertValidWorkspaceId ─────────────────────────────────────────────────

function testAssertValidWorkspaceId(): void {
    // Should not throw on valid input
    assert.doesNotThrow(() => assertValidWorkspaceId('mira'));
    assert.doesNotThrow(() => assertValidWorkspaceId('my-portfolio'));

    // Should throw on each kind of violation
    assert.throws(
        () => assertValidWorkspaceId(''),
        WorkspaceIdValidationError,
        'empty throws',
    );
    assert.throws(
        () => assertValidWorkspaceId('a'.repeat(41)),
        WorkspaceIdValidationError,
        'too long throws',
    );
    assert.throws(
        () => assertValidWorkspaceId('Mira'),
        WorkspaceIdValidationError,
        'uppercase throws',
    );
    assert.throws(
        () => assertValidWorkspaceId('default'),
        WorkspaceIdValidationError,
        'reserved throws',
    );
    assert.throws(
        () => assertValidWorkspaceId('_foo'),
        WorkspaceIdValidationError,
        'underscore prefix throws',
    );
    assert.throws(
        () => assertValidWorkspaceId('mira/x'),
        WorkspaceIdValidationError,
        'slash throws',
    );

    // Error messages should be human-readable (no internal jargon)
    try {
        assertValidWorkspaceId('Mira');
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof WorkspaceIdValidationError);
        assert.ok(
            err.message.length > 10,
            'error message should be substantive',
        );
    }

    console.log('  ✓ assertValidWorkspaceId — throws with helpful messages');
}

// ── suggestWorkspaceId ─────────────────────────────────────────────────────

function testSuggestWorkspaceId(): void {
    // Happy path transformations
    assert.equal(suggestWorkspaceId('Mira'), 'mira', 'lowercase');
    assert.equal(
        suggestWorkspaceId("Mira's Workspace"),
        'miras-workspace',
        'apostrophe + space',
    );
    assert.equal(
        suggestWorkspaceId('My Portfolio'),
        'my-portfolio',
        'spaces become hyphens',
    );
    assert.equal(
        suggestWorkspaceId('  spaces  '),
        'spaces',
        'trim hyphens',
    );
    assert.equal(
        suggestWorkspaceId('multiple   spaces'),
        'multiple-spaces',
        'collapse hyphens',
    );
    assert.equal(
        suggestWorkspaceId('My Workspace'),
        'my-workspace',
        'multi-word',
    );
    assert.equal(
        suggestWorkspaceId('IT (BYOD)'),
        'it-byod',
        'parens dropped',
    );

    // Returns null when no valid candidate possible
    assert.equal(suggestWorkspaceId(''), null, 'empty in');
    assert.equal(suggestWorkspaceId('   '), null, 'whitespace only');
    assert.equal(suggestWorkspaceId('default'), null, 'reserved');
    assert.equal(suggestWorkspaceId('ñ'), null, 'no ASCII chars');
    assert.equal(suggestWorkspaceId('!@#$%'), null, 'no valid chars');
    assert.equal(suggestWorkspaceId(null as unknown as string), null, 'null');

    // Length cap
    const long = 'a'.repeat(60);
    const suggested = suggestWorkspaceId(long);
    assert.ok(suggested !== null && suggested.length <= 40, 'caps at max length');

    console.log('  ✓ suggestWorkspaceId — sane transformations');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function testHelpers(): void {
    const reserved = getReservedWorkspaceNames();
    assert.ok(reserved.includes('default'), 'reserved list includes default');
    assert.ok(reserved.includes('lore'), 'reserved list includes lore');
    assert.ok(reserved.includes('loom'), 'reserved list includes loom');

    assert.equal(getMaxWorkspaceIdLength(), 40, 'max length is 40');

    console.log('  ✓ helpers — exposed correctly');
}

// ── Cross-implementation parity (with Loom Python) ─────────────────────────

function testCrossImplementationParity(): void {
    // These are the exact cases that DEF's Python implementation must
    // produce the same answer for. If anyone changes the rule, both
    // implementations must change together.
    const parityCases: Array<[string, boolean]> = [
        ['mira', true],
        ['personal', true],
        ['my-portfolio-1', true],
        ['team_alpha', true],
        ['abc123', true],
        ['1mira', true],
        ['', false],
        ['Mira', false],
        ['_mira', false],
        ['default', false],
        ['lore', false],
        ['loom', false],
        ['mira workspace', false],
        ['mira/x', false],
        ['ñ', false],
        ['a'.repeat(41), false],
    ];

    for (const [input, expected] of parityCases) {
        const got = isValidWorkspaceId(input);
        assert.equal(
            got,
            expected,
            `parity case "${input}" — expected ${expected} got ${got}`,
        );
    }

    console.log(`  ✓ ${parityCases.length} parity cases — Python mirror must match`);
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('workspace-id unit tests');

    testIsValidWorkspaceId();
    testAssertValidWorkspaceId();
    testSuggestWorkspaceId();
    testHelpers();
    testCrossImplementationParity();

    console.log('\n✓ All workspace-id tests passed.');
}

main().catch((err) => {
    console.error('✗ workspace-id:', err);
    process.exit(1);
});
