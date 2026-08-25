// Re-export barrel — all CLI command handlers have been extracted to commands/*.
// This file is kept so cli/index.ts imports continue to resolve without changes.
export * from './commands/index.js';
