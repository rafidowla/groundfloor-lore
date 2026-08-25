/**
 * whisperBin.ts — locate the whisper.cpp CLI binary, shared by the audio + video
 * extractors (the probe was duplicated in both).
 *
 * audit 2026-06-25 (LOW, PATH ambiguity / defense-in-depth) — prefer an explicit
 * operator-configured path (LORE_WHISPER_BIN) over a bare PATH `which` lookup.
 * The fallback still probes PATH for the known whisper.cpp CLI names, but pinning
 * the binary lets an operator avoid resolving an unrelated executable that
 * happens to sit earlier in PATH — notably the over-generic `main` candidate.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

let _whisperBin: string | null | undefined = undefined; // undefined = not probed yet

export function findWhisperBin(): string | null {
    if (_whisperBin !== undefined) return _whisperBin;
    // 1. Explicit operator config wins — no PATH ambiguity.
    const configured = process.env['LORE_WHISPER_BIN'];
    if (configured && fs.existsSync(configured)) {
        _whisperBin = configured;
        return _whisperBin;
    }
    // 2. Fall back to a PATH lookup for the known whisper.cpp CLI names.
    for (const bin of ['whisper', 'whisper-cpp', 'main']) {
        try {
            const r = spawnSync('which', [bin], { encoding: 'utf8', timeout: 1000 });
            if (r.status === 0 && r.stdout.trim()) {
                _whisperBin = r.stdout.trim();
                return _whisperBin;
            }
        } catch { /* not found */ }
    }
    _whisperBin = null;
    return null;
}

/** Test-only: clear the memoized probe so an env change takes effect. */
export function _resetWhisperBinForTest(): void {
    _whisperBin = undefined;
}
