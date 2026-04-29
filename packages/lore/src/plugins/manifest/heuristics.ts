/**
 * heuristics.ts — Deterministic column detection for the plugin wizard.
 *
 * Per Rafi's direction: try cheap deterministic methods FIRST, escalate to
 * LLM only if confidence is low and the user opted into BYOK. This module
 * is the cheap path — pure pattern matching on column names and sample
 * values. No network, no model.
 *
 * Output is a "heuristic schema proposal" the wizard renders and lets the
 * user refine. The proposal includes:
 *   - One node type per CSV file
 *   - Field mapping suggestions for each LoreNode field (label/content/etc.)
 *   - An idStrategy guess (column kind preferred; falls back to hash)
 *   - A confidence score 0..1 — surfaced to the user so they know when
 *     to look more carefully (and when an LLM might help).
 */

const ID_COLUMN_PATTERNS = [/^id$/i, /^uuid$/i, /^_id$/i, /id$/i];
const NAME_COLUMN_PATTERNS = [/^name$/i, /^label$/i, /^title$/i, /^display_?name$/i];
const EMAIL_COLUMN_PATTERNS = [/^email$/i, /e-?mail/i];
const CONTENT_COLUMN_PATTERNS = [/^description$/i, /^summary$/i, /^body$/i, /^content$/i, /^notes?$/i, /^message$/i];
const PROJECT_COLUMN_PATTERNS = [/^project$/i, /^department$/i, /^dept$/i, /^team$/i, /^org$/i, /^division$/i];
const TAGS_COLUMN_PATTERNS = [/^tags?$/i, /^labels?$/i, /^categor(y|ies)$/i, /^kind$/i, /tag_list/i];
const LANGUAGE_COLUMN_PATTERNS = [/^lang(uage)?$/i, /^locale$/i];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const BOOLEAN_RE = /^(true|false|yes|no|0|1)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DetectedFieldType = 'string' | 'number' | 'boolean' | 'date' | 'email' | 'unique-id';

export interface ColumnDetection {
    name: string;
    detectedType: DetectedFieldType;
    /** Estimated cardinality — "unique" / "low" / "medium" / "high" — based on sample. */
    cardinality: 'unique' | 'low' | 'medium' | 'high';
    /** Field heuristic suggestion for the LoreNode field map. */
    suggestedField?: 'label' | 'content' | 'project' | 'tags' | 'language';
    /** True if this column looks like a primary-key candidate. */
    isIdCandidate: boolean;
    /** Sample values (first 3) for the wizard to show the user. */
    samples: string[];
}

export interface SchemaProposal {
    /** Suggested kebab-case node-type name derived from the file. */
    suggestedNodeTypeName: string;
    /** Per-column detection. */
    columns: ColumnDetection[];
    /** Suggested LoreNode field → CSV column map. */
    suggestedFields: {
        label?: string;
        content?: string;
        project?: string;
        tags?: string;
        language?: string;
    };
    /** Suggested id strategy. column → hash fallback if no obvious id column. */
    suggestedIdStrategy:
        | { kind: 'column'; column: string }
        | { kind: 'hash'; columns: string[] };
    /** Confidence 0..1. >0.7 = high; 0.4–0.7 = medium; <0.4 = consider an LLM pass. */
    confidence: number;
    /** Human-readable notes about the proposal. */
    notes: string[];
}

/**
 * Build a schema proposal from a sample of CSV rows. `rows` is the
 * already-parsed array (each row = column → string value). `fileName`
 * is the source file basename, used to suggest a node type name.
 */
export function proposeSchema(
    rows: Array<Record<string, string>>,
    fileName: string,
): SchemaProposal {
    if (rows.length === 0) {
        return {
            suggestedNodeTypeName: filenameToTypeName(fileName),
            columns: [],
            suggestedFields: {},
            suggestedIdStrategy: { kind: 'hash', columns: [] },
            confidence: 0,
            notes: ['Sample is empty — cannot detect schema.'],
        };
    }

    const sample = rows.slice(0, 100);
    const columnNames = Object.keys(sample[0]!);
    const detections: ColumnDetection[] = columnNames.map((col) => detectColumn(col, sample));

    // Field suggestions
    const suggestedFields: SchemaProposal['suggestedFields'] = {};
    suggestedFields.label = pickFieldByPatterns(detections, NAME_COLUMN_PATTERNS);
    suggestedFields.content = pickFieldByPatterns(detections, CONTENT_COLUMN_PATTERNS)
        ?? pickFieldByPatterns(detections, EMAIL_COLUMN_PATTERNS);
    suggestedFields.project = pickFieldByPatterns(detections, PROJECT_COLUMN_PATTERNS);
    suggestedFields.tags = pickFieldByPatterns(detections, TAGS_COLUMN_PATTERNS);
    suggestedFields.language = pickFieldByPatterns(detections, LANGUAGE_COLUMN_PATTERNS);

    // Id strategy
    const idCandidate = detections.find((d) => d.isIdCandidate && d.cardinality === 'unique');
    const suggestedIdStrategy: SchemaProposal['suggestedIdStrategy'] = idCandidate
        ? { kind: 'column', column: idCandidate.name }
        : { kind: 'hash', columns: pickHashColumns(detections) };

    // Confidence: weighted by what we found
    let confidence = 0;
    const notes: string[] = [];
    if (idCandidate) {
        confidence += 0.4;
        notes.push(`Found unique-id column "${idCandidate.name}".`);
    } else {
        notes.push('No obvious id column — using a stable hash of the first 2-3 columns instead.');
    }
    if (suggestedFields.label) {
        confidence += 0.3;
        notes.push(`Mapped "${suggestedFields.label}" → label.`);
    } else {
        notes.push('No obvious "name"-like column for the node label — defaulting to first text column.');
        // Fallback: first text column
        const firstString = detections.find((d) => d.detectedType === 'string');
        if (firstString) suggestedFields.label = firstString.name;
    }
    if (suggestedFields.content) confidence += 0.15;
    if (suggestedFields.project) confidence += 0.05;
    if (suggestedFields.tags) confidence += 0.05;
    if (Object.keys(suggestedFields).filter((k) => suggestedFields[k as keyof typeof suggestedFields]).length >= 3) {
        confidence += 0.05;
    }
    confidence = Math.min(1, confidence);

    if (confidence < 0.4) {
        notes.push('Heuristic confidence is low — consider configuring an LLM provider to refine the proposal.');
    }

    return {
        suggestedNodeTypeName: filenameToTypeName(fileName),
        columns: detections,
        suggestedFields,
        suggestedIdStrategy,
        confidence,
        notes,
    };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function detectColumn(name: string, rows: Array<Record<string, string>>): ColumnDetection {
    const values = rows.map((r) => (r[name] ?? '').trim()).filter((v) => v.length > 0);
    const nonEmpty = values.length;
    const uniqueCount = new Set(values).size;
    const samples = Array.from(new Set(values)).slice(0, 3);

    const cardinality: ColumnDetection['cardinality'] =
        nonEmpty === 0 ? 'low'
        : uniqueCount === nonEmpty ? 'unique'
        : uniqueCount > nonEmpty * 0.5 ? 'high'
        : uniqueCount > nonEmpty * 0.1 ? 'medium'
        : 'low';

    const isIdCandidate = ID_COLUMN_PATTERNS.some((re) => re.test(name)) && cardinality === 'unique';

    let detectedType: DetectedFieldType = 'string';
    if (values.length > 0) {
        if (values.every((v) => ISO_DATE_RE.test(v))) detectedType = 'date';
        else if (values.every((v) => NUMERIC_RE.test(v))) detectedType = 'number';
        else if (values.every((v) => BOOLEAN_RE.test(v))) detectedType = 'boolean';
        else if (values.every((v) => EMAIL_RE.test(v))) detectedType = 'email';
        else if (isIdCandidate) detectedType = 'unique-id';
    }

    return {
        name,
        detectedType,
        cardinality,
        isIdCandidate,
        samples,
    };
}

function pickFieldByPatterns(
    detections: ColumnDetection[],
    patterns: RegExp[],
): string | undefined {
    for (const d of detections) {
        if (patterns.some((re) => re.test(d.name))) return d.name;
    }
    return undefined;
}

function pickHashColumns(detections: ColumnDetection[]): string[] {
    // Pick the first 2-3 high-cardinality string columns as the hash basis.
    const candidates = detections
        .filter((d) => d.detectedType === 'string' || d.detectedType === 'email')
        .filter((d) => d.cardinality === 'unique' || d.cardinality === 'high' || d.cardinality === 'medium')
        .slice(0, 3);
    return candidates.length > 0 ? candidates.map((d) => d.name) : detections.slice(0, 1).map((d) => d.name);
}

function filenameToTypeName(fileName: string): string {
    // Strip extension, then convert to lowercase_with_underscores.
    const base = fileName.replace(/\.[^.]+$/, '');
    return base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        // Drop trailing 's' for plural→singular (employees → employee).
        // Cheap heuristic; user can rename in the wizard.
        .replace(/s$/, '');
}
