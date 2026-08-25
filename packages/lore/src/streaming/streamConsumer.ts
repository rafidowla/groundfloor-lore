/**
 * streaming/streamConsumer.ts — warm-lane streaming-ingest consumer
 * interface + reference local in-process implementation.
 *
 * Sprint S (2026-05-24). Provides the cloud-pluggable shape for
 * continuous event streams (the four-lane write strategy's "warm"
 * lane). Concrete cloud drivers (Kafka, NATS JetStream, AWS Kinesis,
 * Pulsar, Redpanda) land in cloud activation — Sprint S only ships
 * the interface + the local-process reference impl that powers the
 * /api/stream/connect HTTP endpoint.
 *
 * Why an interface now if no cloud driver ships today:
 *   - Locks the cloud team's drop-in contract before they start.
 *   - The HTTP route handles "client → daemon" chunked-transfer
 *     ingest already; a future Kafka/NATS consumer plugs in here
 *     without touching the route.
 *   - Sprint S gate test asserts the interface surface so accidental
 *     breaks during cloud activation flip a red bar early.
 *
 * Interface naming aligned with Kafka client conventions
 * (@confluentinc/kafka-javascript-client, kafkajs) so a future
 * KafkaStreamConsumer drops in with minimal vocabulary mapping:
 *   - subscribe(topic, handler) → assign workspace + per-event handler
 *   - start() / stop() → connection lifecycle
 *   - commit() → acknowledge to upstream broker (no-op for local)
 *
 * NATS / Kinesis map cleanly:
 *   - NATS JetStream consumer.consume(handler) → handler shape matches
 *     onEvent below; ack() on the message ≡ our commit()
 *   - Kinesis ShardIterator → the iterator's GetRecords loop drives
 *     onEvent; checkpointing the shard sequence ≡ commit(eventId)
 *
 * Sprint L workspace_required + Sprint O outbox-first + Sprint E
 * embed-queued default are invariants the HTTP route enforces BEFORE
 * forwarding the parsed event to a consumer; consumer implementations
 * do NOT need to re-check these.
 */

import type { OutboxStore } from '../outbox/types.js';
import { recordHotWrite } from '../outbox/hotLane.js';

/**
 * Per-event shape after parsing one newline-delimited JSON record
 * off the wire. Format-agnostic — the route parses jsonl|protobuf|
 * avro|… (jsonl is the only one Sprint S ships) and hands a normalized
 * record to the consumer.
 */
export interface StreamEvent {
    /** Stable id from the producer if supplied; otherwise the route
     *  synthesises one. Drives idempotency / dedup at the outbox. */
    id: string;
    /** Workspace the event lands in. Always set by the route (Sprint L
     *  workspace_required is checked before this struct is built). */
    workspace: string;
    /** Outbox operationKind — defaults to 'stream.event' but a producer
     *  may override (e.g. a CDC stream may emit 'node.upsert' directly). */
    operationKind: string;
    /** Free-form payload — small, JSON-serialisable. The replicator
     *  dispatcher routes on operationKind. */
    payload: Record<string, unknown>;
    /** Wall-clock receive time (set by the route). */
    receivedAt: string;
}

/**
 * Per-event ack result the consumer reports back to the route so the
 * route can write a per-event ack frame in the chunked response.
 */
export interface StreamEventAck {
    /** Echoes the event id for client-side correlation. */
    id: string;
    /** True if the event landed in the outbox + downstream commit
     *  succeeded. False if the consumer rejected it (validation /
     *  backpressure / etc.). */
    ok: boolean;
    /** When ok=false, a short machine-readable code: 'validation',
     *  'outbox_failed', 'closed', 'internal'. */
    error?: string;
    /** Optional outbox entry id when commit succeeded — lets a
     *  follow-up dashboard query trace the event through replication. */
    outboxId?: string;
}

/**
 * The cloud-pluggable consumer shape. Implementations:
 *   - LocalStreamConsumer (this file) — in-process; commits straight
 *     to OutboxStore via recordHotWrite. Powers the Sprint S
 *     /api/stream/connect HTTP endpoint and dev/test fixtures.
 *   - KafkaStreamConsumer (cloud, future) — wraps a Kafka client
 *     subscription; onEvent translates a ConsumerRecord into
 *     StreamEvent before delegating to recordHotWrite. commit() maps
 *     to the Kafka offset commit.
 *   - NATSStreamConsumer / KinesisStreamConsumer — analogous.
 *
 * Lifecycle: start() before first onEvent; stop() drains in-flight.
 * The HTTP route calls start() at connection open + stop() at close.
 *
 * Thread model: Node single-threaded event loop. Implementations
 * MUST be reentrant within the same workspace (the route forwards
 * events serially per connection but multiple connections in the same
 * workspace run concurrently).
 */
export interface StreamConsumerAdapter {
    /** Friendly impl name for logs / diagnostics. */
    readonly name: string;

    /** Begin consuming. Cloud impls open the broker subscription here. */
    start(): Promise<void>;

    /**
     * Hand a freshly-parsed event to the consumer. Implementations
     * commit it to the outbox (or upstream broker) and return an ack.
     * MUST NOT throw — surface failures via ack.ok=false instead so
     * the route can keep streaming subsequent events without killing
     * the connection (Sprint S scope guard: malformed events reject
     * per-event; the stream stays open).
     */
    onEvent(event: StreamEvent): Promise<StreamEventAck>;

    /** Cleanly close the upstream subscription. Idempotent. */
    stop(): Promise<void>;

    /**
     * Optional commit hook — for brokers with explicit offset commits
     * (Kafka, Kinesis). Local impl is a no-op. Called by the route
     * after a batch of acks have been written downstream.
     */
    commit?(): Promise<void>;
}

/* ------------------------------------------------------------------
 * LocalStreamConsumer — reference in-process implementation.
 * ------------------------------------------------------------------ */

export interface LocalStreamConsumerOpts {
    /** Sprint O outbox store. recordHotWrite commits the event row;
     *  the existing replicator picks it up async per Sprint O contract. */
    outboxStore: OutboxStore;
    /** Identifier for logs. */
    label?: string;
}

/**
 * In-process consumer that funnels each event straight into the
 * Sprint O outbox via recordHotWrite. Used by:
 *   - the /api/stream/connect HTTP route (production warm-lane ingest)
 *   - test/S-streaming-unit.ts (gate test fixture)
 *
 * No upstream broker → start/stop/commit are no-ops; the lifecycle
 * exists to satisfy the StreamConsumerAdapter interface so cloud
 * drivers slot in identically.
 */
export class LocalStreamConsumer implements StreamConsumerAdapter {
    public readonly name: string;
    private readonly outboxStore: OutboxStore;
    private started = false;

    constructor(opts: LocalStreamConsumerOpts) {
        this.outboxStore = opts.outboxStore;
        this.name = opts.label ?? 'local-stream-consumer';
    }

    async start(): Promise<void> {
        this.started = true;
    }

    async stop(): Promise<void> {
        this.started = false;
    }

    async commit(): Promise<void> {
        // No-op for in-process; the outbox replicator owns its own
        // cursor (Sprint O5 lastReplicatedSequenceId).
    }

    async onEvent(event: StreamEvent): Promise<StreamEventAck> {
        if (!this.started) {
            return { id: event.id, ok: false, error: 'closed' };
        }
        if (!event.workspace) {
            return { id: event.id, ok: false, error: 'validation' };
        }
        try {
            // Cast operationKind through OutboxOperationKind — the route
            // already validated against the allow-list (or accepted the
            // 'stream.event' default), and recordHotWrite re-validates
            // workspace presence as a Sprint L defense-in-depth.
            const entry = await recordHotWrite(this.outboxStore, {
                workspace: event.workspace,
                operationKind: event.operationKind as
                    import('../outbox/types.js').OutboxOperationKind,
                payload: {
                    ...event.payload,
                    streamEventId: event.id,
                    receivedAt: event.receivedAt,
                },
                initiator: 'http:POST /api/stream/connect',
                operation: `stream.${event.operationKind}`,
            });
            return { id: event.id, ok: true, outboxId: entry.id };
        } catch (err) {
            return {
                id: event.id,
                ok: false,
                error: 'outbox_failed',
                // Errors carry context but never the full stack — keep
                // the ack frame small.
            };
        }
    }
}

/**
 * Factory helper — the wiring layer calls this so a future env-flag
 * swap (LORE_STREAM_CONSUMER=kafka) only touches one switch.
 */
export function createDefaultStreamConsumer(
    opts: LocalStreamConsumerOpts,
): StreamConsumerAdapter {
    return new LocalStreamConsumer(opts);
}
