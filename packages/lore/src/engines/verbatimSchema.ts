import { Schema, Field, FixedSizeList, Float32, List, Utf8 } from 'apache-arrow';

export function buildVerbatimText(label: string, content: string, tags: string[] | string): string {
    // Pass 3 — tags is canonically string[]; tolerate a string for legacy
    // callers and hardcoded literals. Join for the embedding text only.
    const tagsStr = Array.isArray(tags) ? tags.join(',') : tags;
    return [label, content, tagsStr].filter(p => p && p.trim() !== '').join('\n\n');
}

/**
 * Build the LanceDB lore_verbatim table schema.
 *
 * The vector field's dimension MUST match the EmbeddingProvider's
 * `dimension`. Slice 6a took this from a hardcoded 384 (Xenova
 * all-MiniLM-L6-v2) to a parameter so future provider swaps (slice 6b
 * cloud BGE-M3, slice 7 multilingual-e5-small) land cleanly.
 *
 * Existing tables retain their original dimension — LanceDB will reject
 * a schema mismatch on writes. Operators changing models against an
 * existing graph need to drop+rebuild the lore_verbatim table (full
 * reconnect pass).
 *
 * Explicit schema (vs. inferred) prevents LanceDB type-inference
 * failures when fields like security_scopes contain empty arrays on
 * first record insertion.
 */
export function buildVerbatimSchema(dimension: number): Schema {
    return new Schema([
        new Field('vector', new FixedSizeList(dimension, new Field('item', new Float32(), true)), false),
        new Field('id', new Utf8(), false),
        new Field('text', new Utf8(), false),
        new Field('type', new Utf8(), true),
        new Field('label', new Utf8(), true),
        new Field('tags', new Utf8(), true),
        new Field('project', new Utf8(), true),
        new Field('ecosystem', new Utf8(), true),
        new Field('updatedAt', new Utf8(), true),
        new Field('security_scopes', new List(new Field('item', new Utf8(), true)), true),
        // V2.1: content hash lets reconnect skip nodes whose text hasn't
        // changed since the last embed. Cheap sha1-16 over the embed text.
        new Field('contentHash', new Utf8(), true),
    ]);
}