import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri expects a fixed port and direct file imports for HMR; see
// https://tauri.app/start/frontend/vite/ for the recommended config.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            // Share the canonical PluginManifest types with the Lore daemon.
            // Pulling directly from the package source keeps the shell + types
            // in lockstep — any spec drift is a compile error here.
            '@lore/manifest': path.resolve(
                __dirname,
                '../../packages/lore/src/plugins/manifest.ts',
            ),
        },
    },
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: 'ws', host, port: 1421 }
            : undefined,
        watch: {
            // Don't crash on file watches into the Rust target dir.
            ignored: ['**/src-tauri/**'],
        },
    },
});
