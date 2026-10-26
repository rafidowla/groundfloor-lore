/**
 * aliasNormalise.ts - the ONE normalisation used to compare entity spellings (design section 9 Q5: "exact normalised
 * match plus a per-workspace alias table"). Pure and locale-independent, so the alias table, plan filters and the
 * `unresolved` list all agree. Changing it changes what matches: bump ALIAS_NORMALISATION_VERSION and re-check
 * stored aliases.
 *
 * Steps, in order:
 *   1. Unicode NFKC (full-width letters, ligatures and compatibility forms become their plain form).
 *   2. Lower-case (`String.prototype.toLowerCase`, never a locale).
 *   3. Remove apostrophes outright (`O'Brien` -> `obrien`).
 *   4. Replace every other punctuation or symbol character with a space (`Smith-Jones, Inc.` -> `smith jones inc`).
 *   5. Collapse runs of whitespace to one space and trim.
 * Letters and digits of any script are kept. There is deliberately NO fuzzy step (no suffix stripping, no
 * abbreviation expansion, no edit distance): two spellings either normalise equal, or an alias says they are the same.
 */

export const ALIAS_NORMALISATION_VERSION = 1;

const APOSTROPHES = /['‘’ʼ`´]/g;
const NON_WORD = /[^\p{L}\p{N}\p{M}\s]/gu;
const SPACES = /[\s ]+/g;

/** Normalise a spelling for comparison. Returns '' when nothing letter-or-digit-like is left. */
export function normaliseAliasValue(raw: string): string {
    return raw
        .normalize('NFKC')
        .toLowerCase()
        .replace(APOSTROPHES, '')
        .replace(NON_WORD, ' ')
        .replace(SPACES, ' ')
        .trim();
}
