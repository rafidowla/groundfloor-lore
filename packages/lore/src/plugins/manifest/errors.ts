/**
 * errors.ts — Manifest validation error types.
 *
 * Why a dedicated error class: callers (the daemon's plugin loader, the
 * scaffolder, future wizard, the CLI's `lore plugin install`) all need to
 * surface field-level diagnostics, not a single string. A typed error
 * with a `.errors[]` array of `{ path, message }` lets each caller render
 * however it wants — JSON for tooling, pretty list for the CLI, an inline
 * panel for the wizard — without re-parsing a free-form message.
 *
 * The `path` is a JSONPath-ish breadcrumb (`lore.inspectors[0].kind`)
 * that points at the offending field in the raw manifest. We deliberately
 * keep it human-readable instead of strict JSONPath — the consumer is a
 * person reading an error, not a parser.
 */

export interface ManifestValidationIssue {
    /**
     * Dot-and-bracket breadcrumb from the manifest root.
     * Examples:
     *   "manifestVersion"
     *   "lore.inspectors[0].kind"
     *   "def.agents[2].tools[1]"
     */
    path: string;
    /** Plain-English description of what's wrong at `path`. */
    message: string;
}

/**
 * Thrown by `validateManifest` when one or more rules are violated.
 *
 * The validator collects ALL issues before throwing, so callers see
 * every problem in one shot rather than playing whack-a-mole. This
 * matches the developer ergonomics of TypeScript's own diagnostics —
 * one compile reveals every error, not just the first.
 */
export class ManifestValidationError extends Error {
    public readonly errors: ManifestValidationIssue[];

    constructor(errors: ManifestValidationIssue[]) {
        const summary = errors.length === 1
            ? `Manifest validation failed: ${errors[0]!.path}: ${errors[0]!.message}`
            : `Manifest validation failed with ${errors.length} issues:\n` +
              errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
        super(summary);
        this.name = 'ManifestValidationError';
        this.errors = errors;
        // Preserve prototype chain across `extends Error` in older targets.
        Object.setPrototypeOf(this, ManifestValidationError.prototype);
    }
}

/**
 * Thrown by `loadManifest` when file IO or parse fails — distinct from
 * structural validation so callers can render an "I couldn't read that
 * file" UX differently from "the file is wrong shape".
 */
export class ManifestLoadError extends Error {
    public readonly cause: 'not-found' | 'not-readable' | 'invalid-utf8' | 'parse-error' | 'unsupported-extension';
    public readonly filePath: string;

    constructor(cause: ManifestLoadError['cause'], filePath: string, detail?: string) {
        const reason = ({
            'not-found': 'file does not exist',
            'not-readable': 'file is not readable',
            'invalid-utf8': 'file is not valid UTF-8',
            'parse-error': 'file did not parse',
            'unsupported-extension': 'file extension is not .yaml/.yml/.json',
        } as const)[cause];
        super(`Manifest load failed (${reason}) at ${filePath}${detail ? `: ${detail}` : ''}`);
        this.name = 'ManifestLoadError';
        this.cause = cause;
        this.filePath = filePath;
        Object.setPrototypeOf(this, ManifestLoadError.prototype);
    }
}
