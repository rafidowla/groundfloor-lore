#!/usr/bin/env tsx
/**
 * writeMosaicQuestion.ts — writes ONE question's raw ingest + propositions
 * into Mosaic. Called once per question, immediately after that question's
 * extraction workflow completes — never batched across questions, so an
 * interruption can only ever lose the ONE question currently in flight, not
 * everything done so far. Every already-written question is durable via
 * Lore's own outbox the moment this script's bulkIngest calls return.
 *
 * Usage: tsx src/writeMosaicQuestion.ts <questionEntriesFile> <workflowResultFile> <dataDir>
 *   questionEntriesFile: JSON array of {index, file, questionId, nodeSessionId, sessionDate} for ONE question
 *   workflowResultFile: JSON array of {index, propositions} for that same question's sessions
 */

import fs from 'node:fs';
import { createBenchmarkLore } from './loreClient.js';
import { loadDataset, ingestInstance } from './ingest.js';
import { writePropositions } from './writePropositions.js';
import type { LongMemEvalInstance } from './types.js';

interface ManifestEntry {
    index: number;
    file: string;
    questionId: string;
    nodeSessionId: string;
    sessionDate: string | null;
}
interface WorkflowResultEntry {
    index: number;
    propositions: Array<{ text: string; source_turn_index: number }> | null;
}

async function main(): Promise<void> {
    const [entriesFile, resultFile, dataDir] = process.argv.slice(2);
    if (!entriesFile || !resultFile || !dataDir) {
        throw new Error('Usage: writeMosaicQuestion.ts <questionEntriesFile> <workflowResultFile> <dataDir>');
    }

    const entries = JSON.parse(fs.readFileSync(entriesFile, 'utf-8')) as ManifestEntry[];
    const results = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as WorkflowResultEntry[];
    const resultByIndex = new Map(results.map((r) => [r.index, r]));

    const questionId = entries[0]?.questionId;
    if (!questionId) throw new Error('No entries.');

    const dataset = loadDataset(
        '/Users/rdowla/Downloads/AiDev/BitBucket/lore/groundfloor-lore/benchmarks/longmemeval/data/longmemeval_s_cleaned.json',
    );
    const instance = dataset.find((i) => i.question_id === questionId) as LongMemEvalInstance;
    if (!instance) throw new Error(`Question ${questionId} not found in dataset.`);

    const { lore } = await createBenchmarkLore(dataDir);
    let propositionsWritten = 0;
    let sessionsMissing = 0;
    const failed: string[] = [];

    try {
        // Raw turns for this question — graph edges ON.
        await ingestInstance(lore, instance, { autolink: true });

        for (const entry of entries) {
            const result = resultByIndex.get(entry.index);
            if (!result || !result.propositions) {
                sessionsMissing++;
                continue;
            }
            const propositions = result.propositions.map((p) => ({ text: p.text, sourceTurnIndex: p.source_turn_index }));
            try {
                const { written } = await writePropositions(
                    lore,
                    questionId,
                    entry.nodeSessionId,
                    entry.sessionDate,
                    propositions,
                    { autolink: true },
                );
                propositionsWritten += written;
            } catch (err) {
                failed.push(`${entry.nodeSessionId}: ${(err as Error).message?.slice(0, 200)}`);
            }
        }
    } finally {
        await lore.dispose();
    }

    console.log(
        `${questionId}: raw ingest done, ${propositionsWritten} proposition nodes written, ` +
            `${sessionsMissing}/${entries.length} sessions had no propositions.`,
    );
    if (failed.length > 0) {
        console.log(`  ${failed.length} write failure(s): ${failed.join('; ')}`);
    }
}

main().catch((err) => {
    console.error('writeMosaicQuestion FAILED:', err);
    process.exitCode = 1;
});
