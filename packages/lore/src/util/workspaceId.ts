/**
 * workspaceId.ts — Workspace identifier normalization and validation.
 *
 * Single source of truth for what counts as a valid workspace identifier
 * across Lore (this engine), Loom (DEF agent runtime — separate Python
 * project), the SDK, the CLI, and the UI.
 *
 * Why a single source of truth:
 *   Per D-R (locked V3 Wave 0): a workspace identifier is shared between
 *   a Lore workspace folder and a Loom tenant ID. If Lore stores it as
 *   "Mira" and Loom as "mira", they diverge and the integration breaks
 *   silently. Per D-CCC and D-T, the identifier also appears in
 *   filesystem paths, HTTP routes, and cross-machine sync addresses.
 *
 * The locked rule (per C-6 — see docs/post_v2_plan.md):
 *   - Lowercase ASCII letters (a-z), digits (0-9), hyphen (-),
 *     underscore (_).
 *   - Must start with a letter or digit (not a hyphen or underscore).
 *   - Length 1–40 characters.
 *   - Reserved names rejected: default, system, admin, internal, lore,
 *     loom, temp, tmp; plus any name starting with "_".
 *   - Whitespace and other characters rejected outright (no silent
 *     transformation — UI must show the candidate to the user for
 *     confirmation, not silently rename).
 *
 * Display name vs identifier:
 *   Users may have a display name like "Mira's Workspace" for the UI.
 *   The identifier ("mira") is what travels through the system. Display
 *   name is stored separately in workspace metadata; identifier is what
 *   functions in this module operate on.
 *
 * License: see LICENSE in the repo root.
 */

/**
 * Validation error with a human-readable reason.
 *
 * Thrown by assertValidWorkspaceId. The message is safe to surface in UI
 * (no internal-only details).
 */
export class WorkspaceIdValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceIdValidationError';
    }
}

/**
 * Reserved identifier names that cannot be used. Lowercase, exact match.
 *
 * Plus: any identifier starting with "_" is also reserved (handled
 * separately because it's a prefix rule, not a name match).
 *
 * Why these names: they collide with system folder names, SQL keywords,
 * URL routes, or Lore/Loom internal concepts. Reject at creation time
 * to avoid surprises later.
 */
const RESERVED_NAMES = new Set([
    'default',
    'system',
    'admin',
    'internal',
    'lore',
    'loom',
    'temp',
    'tmp',
]);

/**
 * Maximum identifier length. 40 characters is enough for any reasonable
 * name and small enough to fit in URL paths, log lines, and file paths
 * without truncation concerns.
 */
const MAX_ID_LENGTH = 40;

/**
 * Regex matching the full set of allowed characters.
 *
 * Anchored to the entire string. Pre-compiled module-level for speed.
 */
const VALID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Check whether a string is a valid workspace identifier as-is.
 *
 * Returns true if the input passes every rule. Returns false for any
 * violation (use assertValidWorkspaceId to learn which rule failed).
 *
 * Pure function. No side effects.
 *
 * @param input The candidate identifier.
 * @returns true if valid; false otherwise.
 */
export function isValidWorkspaceId(input: string): boolean {
    if (typeof input !== 'string') return false;
    if (input.length === 0 || input.length > MAX_ID_LENGTH) return false;
    if (!VALID_PATTERN.test(input)) return false;
    if (RESERVED_NAMES.has(input)) return false;
    if (input.startsWith('_')) return false; // double-check; pattern already enforces start char
    return true;
}

/**
 * Validate a workspace identifier; throw with a helpful message if invalid.
 *
 * Use this at API boundaries (workspace creation endpoint, CLI command,
 * UI form submit) so the error message can flow back to the user.
 *
 * @param input The candidate identifier.
 * @throws WorkspaceIdValidationError if the input fails any rule.
 */
export function assertValidWorkspaceId(input: string): void {
    if (typeof input !== 'string') {
        throw new WorkspaceIdValidationError(
            'Workspace identifier must be a string.',
        );
    }
    if (input.length === 0) {
        throw new WorkspaceIdValidationError(
            'Workspace identifier cannot be empty.',
        );
    }
    if (input.length > MAX_ID_LENGTH) {
        throw new WorkspaceIdValidationError(
            `Workspace identifier must be ${MAX_ID_LENGTH} characters or fewer (got ${input.length}).`,
        );
    }
    if (input.startsWith('_')) {
        throw new WorkspaceIdValidationError(
            'Workspace identifier cannot start with an underscore. Underscore-prefixed names are reserved.',
        );
    }
    if (!VALID_PATTERN.test(input)) {
        throw new WorkspaceIdValidationError(
            'Workspace identifier may contain only lowercase letters (a-z), digits (0-9), hyphens (-), and underscores (_), and must start with a letter or digit.',
        );
    }
    if (RESERVED_NAMES.has(input)) {
        throw new WorkspaceIdValidationError(
            `"${input}" is a reserved name and cannot be used as a workspace identifier. Reserved: ${Array.from(RESERVED_NAMES).join(', ')}.`,
        );
    }
}

/**
 * Suggest a workspace identifier from a user-supplied display name.
 *
 * Lowercases the input, replaces spaces and apostrophes with hyphens,
 * drops other invalid characters, and trims leading/trailing hyphens.
 * Returns null if the result is empty, too short, or fails validation.
 *
 * IMPORTANT: this is a SUGGESTION only. The UI must show the result to
 * the user for confirmation rather than silently rename. Per the locked
 * rule, no automatic transformation happens at the API layer.
 *
 * Examples:
 *   "Mira"               → "mira"
 *   "Mira's Workspace"   → "miras-workspace"
 *   "My Portfolio"       → "my-portfolio"
 *   "  spaces  "         → "spaces"
 *   ""                   → null
 *   "default"            → null (reserved)
 *   "ñ"                  → null (no valid characters left)
 *
 * @param displayName A user-friendly name like "Mira's Workspace".
 * @returns A candidate identifier, or null if no valid candidate can be derived.
 */
export function suggestWorkspaceId(displayName: string): string | null {
    if (typeof displayName !== 'string') return null;

    const candidate = displayName
        .toLowerCase()
        .replace(/['']/g, '') // drop apostrophes outright (Mira's → miras)
        .replace(/\s+/g, '-') // whitespace becomes hyphens
        .replace(/[^a-z0-9_-]/g, '') // drop everything else (parens, punctuation, etc.)
        .replace(/-+/g, '-') // collapse runs of hyphens
        .replace(/^[-_]+|[-_]+$/g, '') // trim leading/trailing hyphens and underscores
        .slice(0, MAX_ID_LENGTH);

    if (candidate.length === 0) return null;
    if (!isValidWorkspaceId(candidate)) return null;
    return candidate;
}

/**
 * Returns the (frozen) set of reserved names so callers can check or
 * display them without importing the module-private constant.
 *
 * Used by the UI to surface "these names are reserved" guidance during
 * workspace creation.
 */
export function getReservedWorkspaceNames(): readonly string[] {
    return Object.freeze([...RESERVED_NAMES]);
}

/**
 * Returns the maximum identifier length so UI can size input fields and
 * surface accurate length warnings.
 */
export function getMaxWorkspaceIdLength(): number {
    return MAX_ID_LENGTH;
}
