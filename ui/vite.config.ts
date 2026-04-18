import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3847'
    }
  },
  build: {
    // The vis-network "Beta renderer" sits behind a Settings toggle most
    // users never flip. lazy() already puts it in its own chunk that
    // only loads on opt-in; bumping the warning threshold to 600 KB
    // silences the nag without hiding a genuine regression in the main
    // bundle (which is ~210 KB after the code-split).
    chunkSizeWarningLimit: 600,
  },
})
