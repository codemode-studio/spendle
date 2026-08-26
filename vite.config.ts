import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    exclude: [
      '@firecrawl/pdf-inspector',
      '@firecrawl/pdf-inspector-darwin-arm64',
    ],
  },
  ssr: { external: ['@firecrawl/pdf-inspector'] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
