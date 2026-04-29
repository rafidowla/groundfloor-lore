/**
 * Manifest loader + validator — clean re-export surface.
 *
 * Callers should import from this barrel rather than from the underlying
 * files (errors / loader / validator) so internal restructuring stays
 * invisible. The exposed names are: loadManifest, loadManifestFromBundle,
 * parseManifest, detectFormat, validateManifest, ManifestValidationError,
 * ManifestLoadError, ManifestValidationIssue.
 */

export {
    loadManifest,
    loadManifestFromBundle,
    parseManifest,
    detectFormat,
    type ManifestFormat,
} from './loader.js';

export { validateManifest } from './validator.js';

export {
    ManifestValidationError,
    ManifestLoadError,
    type ManifestValidationIssue,
} from './errors.js';

export {
    manifestToPlugin,
    isTierOneManifest,
    ManifestPluginAdapterError,
} from './adapter.js';

export {
    runIngest,
    type IngestNodeWrite,
    type IngestRowError,
    type IngestReport,
    type IngestWriter,
} from './ingest.js';

export {
    STOCK_PATTERNS,
    listPatternNames,
    getPattern,
    expandPattern,
    isPatternQueryEntry,
    type QueryPattern,
    type PatternQueryInput,
} from './queryPatterns.js';
