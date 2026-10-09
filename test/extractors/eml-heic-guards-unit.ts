/**
 * test/extractors/eml-heic-guards-unit.ts
 * Run: tsx test/extractors/eml-heic-guards-unit.ts
 *
 * - .eml: byte cap + parse wall-clock timeout (small constants via
 *   createEmlExtractor options; no giant fixtures).
 * - HEIC: magic-byte (ISO-BMFF ftyp + HEIF brand) check before sharp.
 */
import * as assert from 'node:assert/strict';
import {
    createEmlExtractor, emlExtractor, MAX_EML_BYTES, EML_PARSE_TIMEOUT_MS,
} from '../../packages/lore/src/engines/extractors/eml.js';
import { heicExtractor, hasHeifSignature } from '../../packages/lore/src/engines/extractors/image.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

const EML = Buffer.from(
    'From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: Hi\r\n' +
    'Date: Mon, 01 Jan 2024 10:00:00 +0000\r\nMessage-ID: <a@b>\r\n\r\nHello body\r\n',
);

async function rejects(p: Promise<unknown>, code: string, msg: RegExp): Promise<void> {
    try { await p; } catch (e) {
        assert.ok(e instanceof ExtractorError, `expected ExtractorError, got ${e}`);
        assert.equal((e as ExtractorError).code, code);
        assert.match((e as Error).message, msg);
        return;
    }
    assert.fail('expected rejection');
}

async function main(): Promise<void> {
    // ── eml ──
    assert.equal(MAX_EML_BYTES, 25 * 1024 * 1024);
    assert.equal(EML_PARSE_TIMEOUT_MS, 30_000);

    const ok = await emlExtractor.extract(EML, 'message/rfc822');
    assert.match(ok.text, /Hello body/);
    console.log('  ✓ default eml extractor still parses a normal message');

    const small = createEmlExtractor({ maxBytes: EML.byteLength });
    await small.extract(EML, 'message/rfc822'); // exactly at the cap: allowed
    await rejects(
        createEmlExtractor({ maxBytes: EML.byteLength - 1 }).extract(EML, 'message/rfc822'),
        'too-large', /limit for \.eml input/,
    );
    console.log('  ✓ eml byte cap: at-cap allowed, over-cap rejected (too-large)');

    let called = false;
    await rejects(
        createEmlExtractor({ maxBytes: 10, simpleParser: async () => { called = true; return {}; } })
            .extract(EML, 'message/rfc822'),
        'too-large', /limit/,
    );
    assert.equal(called, false, 'parser not invoked for oversized input');
    console.log('  ✓ oversized eml never reaches the parser');

    const hang = createEmlExtractor({ parseTimeoutMs: 50, simpleParser: () => new Promise(() => { /* never */ }) });
    const t0 = Date.now();
    await rejects(hang.extract(EML, 'message/rfc822'), 'corrupt', /Failed to parse email: timed out after 50 ms/);
    assert.ok(Date.now() - t0 < 2000, 'timeout fired promptly');
    console.log('  ✓ eml parse timeout rejects with ExtractorError(corrupt)');

    // a late rejection from the abandoned parse must not become unhandled
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    const late = createEmlExtractor({
        parseTimeoutMs: 20,
        simpleParser: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 80)),
    });
    await rejects(late.extract(EML, 'message/rfc822'), 'corrupt', /timed out/);
    await new Promise(r => setTimeout(r, 200));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, 0);
    console.log('  ✓ abandoned parse leaves no unhandled rejection');

    // parser failure still maps to corrupt
    await rejects(
        createEmlExtractor({ simpleParser: async () => { throw new Error('boom'); } }).extract(EML, 'message/rfc822'),
        'corrupt', /Failed to parse email: boom/,
    );
    console.log('  ✓ parser errors keep the existing corrupt mapping');

    // ── heic ──
    const ftyp = (brand: string, compat: string[] = []): Buffer => {
        const size = 16 + compat.length * 4;
        const b = Buffer.alloc(size + 8);
        b.writeUInt32BE(size, 0);
        b.write('ftyp', 4, 'latin1');
        b.write(brand, 8, 'latin1');
        compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
        return b;
    };
    for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) {
        assert.equal(hasHeifSignature(ftyp(brand)), true, brand);
    }
    assert.equal(hasHeifSignature(ftyp('isom', ['mp41', 'heic'])), true, 'compatible brand');
    assert.equal(hasHeifSignature(ftyp('avif')), false, 'avif not accepted');
    assert.equal(hasHeifSignature(ftyp('isom', ['mp41'])), false, 'mp4');
    assert.equal(hasHeifSignature(Buffer.from('ftyp')), false, 'too short');
    console.log('  ✓ hasHeifSignature brand matrix');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await rejects(heicExtractor.extract(svg, 'image/heic'), 'corrupt', /Not a HEIC\/HEIF image/);
    await rejects(heicExtractor.extract(Buffer.from('GIF89a......'), 'image/heif'), 'corrupt', /Not a HEIC\/HEIF image/);
    console.log('  ✓ SVG / non-ISO-BMFF bytes named .heic are rejected before sharp');

    await rejects(heicExtractor.extract(Buffer.alloc(0), 'image/heic'), 'empty', /empty/);

    // Valid brand but truncated payload: passes the guard, reaches sharp, and
    // takes the pre-existing conversion-failure path (no throw).
    const r = await heicExtractor.extract(ftyp('heic'), 'image/heic');
    assert.equal(r.text, '');
    assert.ok(typeof r.metadata['conversionError'] === 'string', 'reached sharp');
    console.log('  ✓ valid HEIF brand reaches sharp (truncated body -> conversionError, existing behaviour)');

    console.log('eml-heic-guards: all passed');
}

main().catch(e => { console.error(e); process.exit(1); });
