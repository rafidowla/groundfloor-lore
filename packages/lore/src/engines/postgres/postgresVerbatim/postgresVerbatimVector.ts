/**
 * postgresVerbatimVector.ts — pgvector serialization + score mapping for
 * PostgresVerbatimStore (Postgres engine). Mirrors the role of
 * `engines/sqliteVerbatimVector.ts`'s float32-LE BLOB codec for pgvector's
 * `vector` column type.
 *
 * ENCODING (write path): text literal `'[v1,v2,…]'` bound as a query
 * parameter and cast `$n::vector`. pgvector's input parser converts each
 * decimal with strtof (round-to-nearest float32), and the decimal JS prints
 * for a float32-valued double always round-trips to that same double — so
 * the stored float32 is bit-identical to the Float32Array element the caller
 * supplied. (A binary encode path would need `vector_recv`, which is not
 * SQL-callable.)
 *
 * DECODING (read path): `vector::text` is NOT bit-safe. pgvector (0.8.5,
 * verified empirically) prints ~8 significant
 * digits — `'[0.123456789012, 1e-8, 3.14159265358979]'::vector::text` gives
 * `[0.12345679,1e-08,3.1415927,…]`, and a float32 needing its 9th digit
 * reparses one ULP off. Reads therefore go through the binary send function
 * `vector_send(vector)`, whose wire shape (verified the same way:
 * `encode(vector_send('[0.123456789012, 1e-8, 3.14159265358979]'::vector),
 * 'hex')` = `000300003dfcd6ea322bcc7740490fdb`) is:
 *
 *     uint16 dim       (big-endian)
 *     uint16 unused
 *     dim × float32    (big-endian — ALL Postgres binary wire data is
 *                       network byte order, pq_sendfloat4)
 *
 * which reproduces the stored float32 bit-exactly. Widening float32 →
 * JS number is exact, so a decoded vector is identical to
 * sqliteVerbatimVector.decodeVector's output for the same stored value.
 *
 * UNIT-NORM BEHAVIOR: vectors are stored EXACTLY as the provider returned
 * them — no re-normalization at this layer, matching the SQLite engine
 * (sqliteVerbatimWrite.ts stores `encodeVector(provider output)` verbatim).
 * Cosine similarity is norm-invariant, so pgvector's
 * `vector_cosine_ops` distance (`<=>`) produces the same score for a
 * unit-normalized and a non-normalized copy of a vector, exactly like the
 * SQLite path's `vec_distance_cosine` / JS dot-product fallback; the
 * fixed-seed unit vectors bulk loaders supply behave identically on both
 * engines.
 */

/** Serialize a vector as the pgvector text literal bound as a parameter. */
export function toPgVectorText(vec: readonly number[] | Float32Array): string {
    const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    return `[${Array.from(arr).join(',')}]`;
}

/**
 * Decode a `vector_send(vector)` bytea payload (see header for the wire
 * shape) back to a Float32Array, bit-identical to what was stored. Returns
 * null for a SQL NULL (no embedding) or a payload too short to hold the
 * declared dim — a corrupt/truncated value degrades to "unembedded" exactly
 * like decodeVector's null contract on the SQLite side, never a throw.
 */
export function decodePgVector(buf: Buffer | null): Float32Array | null {
    if (!buf || buf.length < 4) return null;
    const dim = buf.readUInt16BE(0);
    if (dim < 1 || buf.length < 4 + dim * 4) return null;
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) out[i] = buf.readFloatBE(4 + i * 4);
    return out;
}
