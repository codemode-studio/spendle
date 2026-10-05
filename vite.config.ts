import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig(({ mode }) => {
  // Server functions read SPENDLE_* from process.env; Vite only exposes
  // .env files to import.meta.env, so copy the server-side ones over.
  const env = loadEnv(mode, process.cwd(), 'SPENDLE_')
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value
  return {
    resolve: { tsconfigPaths: true },
    // `pnpm dev` binds to the Tailscale address. Allow the MagicDNS name too;
    // Vite rejects unknown Host headers by default.
    server: { allowedHosts: ['.ts.net'] },
    plugins: [
      // Vite forwards browser errors to the terminal. Piping server logs back to
      // the browser creates a feedback loop that can fill the disk with logs.
      devtools({ consolePiping: { enabled: false } }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  }
})

export default config
