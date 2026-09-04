/**
 * security/secretScan.ts — secret screening for the memory/embed write path.
 *
 * 2.6 (2026-08-17): the write path had zero secret screening — anything written
 * via store_verbatim / store_node / captureIfWorthRemembering was stored and
 * embedded unscreened, and with LORE_EMBEDDING_PROVIDER=openai-compat that text
 * was POSTed to a third-party endpoint. This is a basic, fast REDACTION scan
 * (not a detector): high-signal secret shapes are replaced with a marker so the
 * secret never persists in the vector layer nor leaves the machine via the
 * embedder.
 *
 * Deliberately conservative — a false positive here silently degrades a real
 * document, so only well-known vendor token shapes are matched.
 *
 * DECISION (2026-09-03, see docs/DATA_CONTRACT.md): this is a BEST-EFFORT
 * courtesy, not a security guarantee and not a general redaction layer. Lore
 * does not sanitize free text — callers (Atlas, Loom, SDK users) are
 * responsible for scrubbing secrets/PII before calling. This scan is applied
 * at exactly three call sites, all on the vector/embed layer only
 * (verbatimStore.ts store/storeBatch, verbatimSearchWorkerProxy.ts's
 * parent-embeds branch) and matches only the five vendor shapes below — the
 * outbox, bulkIngest sync mode, the Arcade vector store, sync/replication,
 * and the graph substrate itself (including supersede_node's `reason`) all
 * persist text unfiltered. See docs/DATA_CONTRACT.md for the full list of
 * unredacted sinks and the reasoning.
 */

/** High-signal, low-false-positive secret shapes. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    // OpenAI / generic "sk-" keys.
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    // AWS access key ids (AKIA…).
    /\bAKIA[0-9A-Z]{16}\b/g,
    // GitHub personal access tokens.
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    // Slack tokens.
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    // PEM private keys (RSA / EC / OpenSSH / DSA).
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    // Audit 5.7 (2026-08-17): the former generic
    // `(api_key|secret|token|password|passwd)\s*[:=]\s*<12+ chars>` rule was
    // DROPPED — it fired on ordinary code (`const token = crypto.randomBytes(...)`,
    // `const apiKey = process.env.X`, docs about API keys) with no warning, so
    // stored text was silently mangled and two genuinely-different writes could
    // redact to the identical '[REDACTED]' placeholder and collapse into a
    // skip-identical no-op. Vendor shapes above have literal prefixes with a
    // near-zero false-positive rate; a generic assignment shape does not.
];

/** Replace every detected secret shape with a stable marker. */
export function redactSecrets(text: string): string {
    let out = text;
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, '[REDACTED]');
    }
    return out;
}
