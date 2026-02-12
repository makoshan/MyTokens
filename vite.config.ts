import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { RollupOptions } from 'rollup'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: './',
  publicDir: '../public', // Point to project root public dir if it exists/created later
  // Vite options tailored for Tauri to prevent too much magic
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      // using polling since fsEvents doesn't work on all platforms
      usePolling: true,
    },
  },
  build: {
    outDir: '../dist', // Output to project root dist/
    emptyOutDir: true,
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
