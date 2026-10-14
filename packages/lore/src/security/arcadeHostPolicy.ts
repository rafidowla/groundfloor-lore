/**
 * arcadeHostPolicy.ts — Host-header (DNS-rebinding) allowlist for the arcade
 * listener (3.34.0, Nokshi M6).
 *
 * WHY: the standard listener runs `isAllowedHost` (security/httpAuth.ts) on
 * every request; arcadeDispatch never did, so any Host was accepted. A web page
 * that rebinds its own DNS name to the operator's machine/network can then send
 * requests to the listener with `Host: evil.example`. A browser always sends
 * the page's own hostname as Host, so an allowlist on Host defeats the attack.
 *
 * REAL EXPOSURE IS LOW and this is defence in depth: the listener binds
 * 127.0.0.1 and every route except /health and /ready needs a bearer token.
 *
 * DEFAULT POLICY ("relaxed", chosen so a relay container that forwards the
 * original Host keeps working without configuration):
 *   1. exact loopback `name:port` (httpAuth.isAllowedHost — shared with the
 *      standard listener), then
 *   2. loopback names on any port (a relay/port-map changes the port),
 *   3. IP literals (v4 and bracketed v6) — a rebinding page is reached by a
 *      DNS name, never by an IP literal,
 *   4. dotless single-label names (`lore`, `lore-daemon`: container / service
 *      names) — an attacker-controlled rebinding domain always has a dot,
 *   5. a missing Host header (HTTP/1.0 probes; browsers always send Host),
 *   6. anything listed in LORE_ARCADE_ALLOWED_HOSTS.
 * A dotted DNS name that is not listed (the public name, e.g. lore.example.com)
 * is refused 403 `host_not_allowed` until it is added to the list.
 *
 * ENV:
 *   LORE_ARCADE_ALLOWED_HOSTS  comma-separated entries: `name` (any port),
 *                              `name:port` (exact), `*.suffix` (any subdomain),
 *                              `[::1]` / `[::1]:3847`, or `*` (disable the
 *                              check entirely).
 *   LORE_ARCADE_HOST_CHECK     `strict` drops rules 2-5: only rule 1 plus the
 *                              list (and the missing-Host rule is dropped too).
 */

import { isAllowedHost } from './httpAuth.js';

export interface ArcadeHostPolicy {
    /** True when a request carrying this Host header may proceed. */
    isAllowed(hostHeader: string | undefined): boolean;
    /** Human-readable summary for the boot log. Never contains a secret. */
    describe(): string;
}

interface ParsedHost {
    hostname: string;
    port: string | undefined;
}

/** Split `name`, `name:port`, `[v6]` or `[v6]:port`. Returns null if malformed. */
export function parseHostHeader(raw: string): ParsedHost | null {
    const h = raw.trim().toLowerCase();
    if (h.length === 0 || h.length > 255 || /[\s/\\@#?]/.test(h)) return null;
    const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(h);
    if (v6) return { hostname: `[${v6[1]}]`, port: v6[2] };
    const m = /^([a-z0-9._-]+?)(?::(\d{1,5}))?$/.exec(h);
    if (!m) return null;
    // A trailing dot is an absolute FQDN spelling of the same name.
    return { hostname: m[1]!.replace(/\.$/, ''), port: m[2] };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isLoopbackName(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]'
    );
}

function isIpLiteral(hostname: string): boolean {
    return IPV4.test(hostname) || hostname.startsWith('[');
}

interface Entry {
    /** `*.suffix` entries store the suffix (".suffix"); others the exact name. */
    name: string;
    wildcard: boolean;
    port: string | undefined;
}

function parseEntries(list: string): { entries: Entry[]; allowAll: boolean } {
    const entries: Entry[] = [];
    let allowAll = false;
    for (const part of list.split(',')) {
        const t = part.trim().toLowerCase();
        if (!t) continue;
        if (t === '*') {
            allowAll = true;
            continue;
        }
        const wildcard = t.startsWith('*.');
        const parsed = parseHostHeader(wildcard ? t.slice(2) : t);
        if (!parsed) continue; // malformed entry: ignored, never widens the policy
        entries.push({
            name: wildcard ? `.${parsed.hostname}` : parsed.hostname,
            wildcard,
            port: parsed.port,
        });
    }
    return { entries, allowAll };
}

export function buildArcadeHostPolicy(opts: {
    /** The port the listener serves on (for the shared exact-loopback rule). */
    port: number;
    env?: NodeJS.ProcessEnv;
}): ArcadeHostPolicy {
    const env = opts.env ?? process.env;
    const { entries, allowAll } = parseEntries(env['LORE_ARCADE_ALLOWED_HOSTS'] ?? '');
    const strict = (env['LORE_ARCADE_HOST_CHECK'] ?? '').trim().toLowerCase() === 'strict';

    const listed = (p: ParsedHost): boolean =>
        entries.some((e) => {
            if (e.port !== undefined && e.port !== p.port) return false;
            return e.wildcard ? p.hostname.endsWith(e.name) : p.hostname === e.name;
        });

    return {
        isAllowed(hostHeader: string | undefined): boolean {
            if (allowAll) return true;
            if (hostHeader === undefined || hostHeader === '') return !strict;
            if (isAllowedHost(hostHeader, opts.port)) return true;
            const p = parseHostHeader(hostHeader);
            if (!p) return false;
            if (listed(p)) return true;
            if (strict) return false;
            return isLoopbackName(p.hostname) || isIpLiteral(p.hostname) || !p.hostname.includes('.');
        },
        describe(): string {
            if (allowAll) return 'Host check disabled (LORE_ARCADE_ALLOWED_HOSTS=*)';
            const names = entries.map((e) => `${e.wildcard ? '*' : ''}${e.name}${e.port ? ':' + e.port : ''}`);
            return `Host check ${strict ? 'strict' : 'relaxed'}; extra allowed: ${names.length ? names.join(', ') : '(none)'}`;
        },
    };
}
