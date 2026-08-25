#!/usr/bin/env tsx
/**
 * writeMosaicFromWorkflow.ts — one-shot script: takes the workflow's
 * proposition-extraction results (JSON array, same order as the manifest)
 * and writes everything into the Mosaic data directory:
 *   1. Raw turn ingest (ingestInstance, autolink:true — graph edges ON)
 *   2. Proposition nodes (writePropositions, autolink:true)
 *
 * Usage: tsx src/writeMosaicFromWorkflow.ts <manifestFile> <workflowResultFile> <dataDir>
 */

import fs from 'node:fs';
import { createBenchmarkLore } from './loreClient.js';
import { loadDataset } from './ingest.js';
import { ingestInstance } from './ingest.js';
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
    const [manifestFile, resultFile, dataDir] = process.argv.slice(2);
    if (!manifestFile || !resultFile || !dataDir) {
        throw new Error('Usage: writeMosaicFromWorkflow.ts <manifestFile> <workflowResultFile> <dataDir>');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as ManifestEntry[];
    const workflowResults = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as WorkflowResultEntry[];
    const resultByIndex = new Map(workflowResults.map((r) => [r.index, r]));

    const dataset = loadDataset(
        '/Users/rdowla/Downloads/AiDev/BitBucket/lore/groundfloor-lore/benchmarks/longmemeval/data/longmemeval_s_cleaned.json',
    );
    const byId = new Map(dataset.map((i) => [i.question_id, i]));

    const byQuestion = new Map<string, ManifestEntry[]>();
    for (const entry of manifest) {
        const arr = byQuestion.get(entry.questionId) ?? [];
        arr.push(entry);
        byQuestion.set(entry.questionId, arr);
    }

    const { lore } = await createBenchmarkLore(dataDir);
    let questionsIngested = 0;
    let propositionsWritten = 0;
    let sessionsMissing = 0;
    const failed: string[] = [];

    try {
        for (const [questionId, entries] of byQuestion) {
            const instance = byId.get(questionId) as LongMemEvalInstance;
            try {
                await ingestInstance(lore, instance, { autolink: true });
                questionsIngested++;
            } catch (err) {
                failed.push(`${questionId} (raw ingest): ${(err as Error).message?.slice(0, 200)}`);
                continue;
            }

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
                    failed.push(`${questionId}/${entry.nodeSessionId} (propositions): ${(err as Error).message?.slice(0, 200)}`);
                }
            }
            console.log(`  ${questionId}: ingested + propositions written`);
        }
    } finally {
        await lore.dispose();
    }

    console.log(
        `\nDone: ${questionsIngested} questions raw-ingested, ${propositionsWritten} proposition nodes written, ` +
            `${sessionsMissing} sessions had no propositions (extraction failure or genuinely empty).`,
    );
    if (failed.length > 0) {
        console.log(`\n${failed.length} failure(s):`);
        for (const f of failed) console.log(`  ${f}`);
    }
}

main().catch((err) => {
    console.error('writeMosaicFromWorkflow FAILED:', err);
    process.exitCode = 1;
});
