/**
 * ingestion/policy.ts — per-workspace processing policy.
 *
 * `local-only` (the default) means nothing about a workspace's files may leave
 * the machine: the coordinator refuses every processor whose locality is
 * `hosted`. `hosted-allowed` is an explicit, per-workspace opt-in.
 *
 * The check is a pure function so it can sit at BOTH choke points: processor
 * selection (registry) and dispatch (coordinator). A hosted processor can
 * never be reached by skipping one of them.
 */
import type { ProcessorInfo } from './contracts.js';

export type ProcessingPolicy = 'local-only' | 'hosted-allowed';
export const DEFAULT_POLICY: ProcessingPolicy = 'local-only';

export class PolicyViolationError extends Error {
    readonly code = 'policy_violation';
    constructor(public readonly workspace: string, public readonly processorId: string) {
        super(`workspace '${workspace}' is local-only: hosted processor '${processorId}' refused`);
        this.name = 'PolicyViolationError';
    }
}

export function isProcessingPolicy(v: unknown): v is ProcessingPolicy {
    return v === 'local-only' || v === 'hosted-allowed';
}

/** Anything that is not exactly `hosted-allowed` is treated as `local-only` (fail closed). */
export function normalizePolicy(v: unknown): ProcessingPolicy {
    return v === 'hosted-allowed' ? 'hosted-allowed' : 'local-only';
}

export function assertProcessorAllowed(workspace: string, policy: ProcessingPolicy, info: ProcessorInfo): void {
    if (info.locality === 'hosted' && policy !== 'hosted-allowed') {
        throw new PolicyViolationError(workspace, info.id);
    }
}

/** Where the per-workspace policy comes from. Missing workspace => default. */
export interface IPolicyProvider {
    policyFor(workspace: string): Promise<ProcessingPolicy>;
}

/** Simple in-memory provider; hosts wire a persistent one. */
export class StaticPolicyProvider implements IPolicyProvider {
    private readonly map = new Map<string, ProcessingPolicy>();
    set(workspace: string, policy: ProcessingPolicy): void {
        this.map.set(workspace, normalizePolicy(policy));
    }
    async policyFor(workspace: string): Promise<ProcessingPolicy> {
        return this.map.get(workspace) ?? DEFAULT_POLICY;
    }
}
