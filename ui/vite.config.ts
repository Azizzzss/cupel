import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Built assets are embedded into the `cupel` binary and served from whatever
// path the control plane chooses, so every URL in the output has to be
// relative. That is what `base` is doing here; without it the app loads its
// own assets from `/` and only works when served from the root.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // A lab tool that ships inside a binary should notice when its interface
    // starts costing more than the chain it is watching.
    chunkSizeWarningLimit: 300,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
