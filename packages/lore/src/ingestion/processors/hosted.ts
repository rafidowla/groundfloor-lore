/**
 * ingestion/processors/hosted.ts — hosted adapters (opt-in per workspace).
 *
 *  - AiApiExtractProcessor     contract A  -> ai-api File Content Extractor
 *  - StructuringV2Processor    contract B  -> ai-api Structuring V2
 *
 * Both are asynchronous: the request is accepted (2xx) and the result arrives
 * on the signed callback (callbackParse.ts). Locality is `hosted`, so the
 * coordinator refuses them unless the workspace policy is `hosted-allowed`.
 * Endpoints come from host config and must be on the allowlist.
 */
import {
    ProcessorError, type ExtractRequest, type ExtractResult, type IExtractProcessor, type IStructureProcessor,
    type ProcessorOutcome, type StructureRequest, type StructureResult,
} from '../contracts.js';
import { postJson, type HttpConfig } from './http.js';

export interface HostedEndpointConfig {
    id: string;
    /** Full URL of the processor's submit endpoint. Must be on the allowlist. */
    endpoint: string;
    /** Service credential for the submit call, from host config/secret store. Never logged. */
    serviceToken?: string;
    engineVersion: string;
    http: HttpConfig;
}

function authHeaders(c: HostedEndpointConfig): Record<string, string> {
    return c.serviceToken ? { authorization: `Bearer ${c.serviceToken}` } : {};
}

function remoteId(json: unknown): string | undefined {
    const j = json as { requestID?: unknown; request_id?: unknown } | undefined;
    const v = j?.requestID ?? j?.request_id;
    return typeof v === 'string' ? v.slice(0, 200) : undefined;
}

export class AiApiExtractProcessor implements IExtractProcessor {
    readonly info: IExtractProcessor['info'];
    constructor(private readonly cfg: HostedEndpointConfig & { aiEngine?: 'gemini' | 'openai'; mimeTypes?: readonly string[] }) {
        this.info = { id: cfg.id, kind: 'extract', locality: 'hosted', version: cfg.engineVersion };
    }
    supports(mime: string): boolean {
        const list = this.cfg.mimeTypes;
        return !list || list.includes(mime.toLowerCase());
    }
    async extract(req: ExtractRequest): Promise<ProcessorOutcome<ExtractResult>> {
        if (!req.fileUrl || !req.callbackUrl) throw new ProcessorError('hosted extract needs fileUrl and callbackUrl', false);
        const ext = (req.fileName.split('.').pop() ?? '').toLowerCase();
        const payload = {
            request_id: req.jobId,
            callback_url: req.callbackUrl,
            ...(req.callbackBearer ? { bearer_token: req.callbackBearer } : {}),
            ai_engine: this.cfg.aiEngine ?? 'gemini',
            file_path: req.fileUrl,
            file_name_standardized: req.fileName.replace(/\.[^.]+$/, ''),
            file_extension_lower: ext,
            prompt: req.prompt ?? '',
            ignore_media: 'no',
            output_as_file: 'no',
            is_uploaded_file: false,
        };
        const { json } = await postJson(this.cfg.http, this.cfg.endpoint, payload, authHeaders(this.cfg));
        return { status: 'accepted', remoteRequestId: remoteId(json) };
    }
}

export class StructuringV2Processor implements IStructureProcessor {
    readonly info: IStructureProcessor['info'];
    constructor(private readonly cfg: HostedEndpointConfig & { aiEngine?: 'gemini' | 'openai'; contentField?: string }) {
        this.info = { id: cfg.id, kind: 'structure', locality: 'hosted', version: cfg.engineVersion };
    }
    async structure(req: StructureRequest): Promise<ProcessorOutcome<StructureResult>> {
        if (!req.callbackUrl) throw new ProcessorError('hosted structure needs callbackUrl', false);
        const payload: Record<string, unknown> = {
            request_id: req.jobId,
            callback_url: req.callbackUrl,
            ...(req.callbackBearer ? { bearer_token: req.callbackBearer } : {}),
            ai_engine: this.cfg.aiEngine ?? 'gemini',
            // The input-text field name is configurable: it is not documented in the Structuring V2 design doc.
            [this.cfg.contentField ?? 'content']: req.text,
            output_format: 'json',
            ...(req.profile ? { profile: req.profile } : {}),
            ...(req.outputSchema ? { output_schema: req.outputSchema } : {}),
            ...(req.itemPath ? { item_path: req.itemPath } : {}),
            ...(req.itemKey ? { item_key: req.itemKey } : {}),
            ...(req.sourceRefs !== undefined ? { source_refs: req.sourceRefs } : {}),
            ...(req.reviewThreshold !== undefined ? { review_threshold: req.reviewThreshold } : {}),
            ...(req.instructions ? { instructions: req.instructions } : {}),
        };
        const { json } = await postJson(this.cfg.http, this.cfg.endpoint, payload, authHeaders(this.cfg));
        return { status: 'accepted', remoteRequestId: remoteId(json) };
    }
}
