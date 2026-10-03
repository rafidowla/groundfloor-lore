#!/usr/bin/env tsx
/**
 * cloud-parity-unit.ts — drives the cloud-parity harness over SCENARIOS (local embedded
 * storage vs mock Dataplane). Slices B/C append scenarios in helpers/cloud-parity-harness.ts.
 */
import { runParity, KNOWN_GAPS_SLICE_B, SCENARIOS } from './helpers/cloud-parity-harness.js';

console.log('cloud parity: local vs mock-cloud');
const report = await runParity();
let failed = 0;
for (const r of report.results) {
    if (r.ok) console.log(`  ✓ ${r.name}`);
    else {
        failed++;
        console.error(`  ✗ ${r.name}`);
        if (r.error) console.error(`    ${r.error}`);
        else console.error(`    local: ${JSON.stringify(r.local)}\n    cloud: ${JSON.stringify(r.cloud)}`);
    }
}
for (const g of report.skippedGaps) console.log(`  - SKIP (Slice B gap): ${g}`);
for (const d of report.divergences) console.log(`  - SKIP (known divergence): ${d}`);
console.log(`\n${report.results.length - failed} passed, ${failed} failed, ${KNOWN_GAPS_SLICE_B.length} known gaps skipped (${SCENARIOS.length} scenarios)`);
process.exit(failed === 0 ? 0 : 1);
