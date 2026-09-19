import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // `pnpm dev` binds to the Tailscale address. Allow the MagicDNS name too;
  // Vite rejects unknown Host headers by default.
  server: { allowedHosts: ['.ts.net'] },
  optimizeDeps: {
    exclude: [
      '@firecrawl/pdf-inspector',
      '@firecrawl/pdf-inspector-darwin-arm64',
    ],
  },
  ssr: { external: ['@firecrawl/pdf-inspector'] },
  plugins: [
    // Vite forwards browser errors to the terminal. Piping server logs back to
    // the browser creates a feedback loop that can fill the disk with logs.
    devtools({ consolePiping: { enabled: false } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
