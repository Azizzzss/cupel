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
    // The control room's API, made same-origin during development. The page
    // on 5173 used to call 8544 directly, the control room sends no CORS
    // headers, and so pressing the button produced a real block and then
    // reported a failure: the browser threw away the answer to a request that
    // had worked. Proxying puts dev, preview and the binary on one path.
    proxy: { '/api': 'http://127.0.0.1:8544' },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:8544' },
  },
})
