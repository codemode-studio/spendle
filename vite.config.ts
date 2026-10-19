import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv, lazyPlugins } from 'vite-plus'
import { cloudflare } from '@cloudflare/vite-plugin'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig(({ command, mode, isPreview }) => {
  // `vp run dev` (and QA) runs the web app on Node against the Node API
  // server. Builds are for Cloudflare Workers, and `vp preview` runs them in
  // the local Workers runtime: the Worker in `packages/cloudflare` wraps the
  // app, and `src/platform` modules are swapped for the ones that use its
  // bindings.
  const workers = command === 'build' || isPreview === true
  // Server code reads these from process.env; Vite only exposes .env files to
  // import.meta.env, so copy the server-side ones over. None reach the client.
  const env = loadEnv(mode, process.cwd(), [
    'SPENDLE_',
    'BETTER_AUTH_',
    'GOOGLE_',
  ])
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value
  return {
    fmt: {
      semi: false,
      singleQuote: true,
      trailingComma: 'all',
      printWidth: 80,
      sortPackageJson: false,
      ignorePatterns: [
        '.repos/**',
        'pnpm-lock.yaml',
        'src/routeTree.gen.ts',
        '.agents/skills/pluggy-*/**',
        'packages/server/evals/**/baselines/**',
        'plans/**/*.html',
        'packages/pdf/wasm/**',
      ],
    },
    lint: {
      plugins: ['eslint', 'typescript', 'import', 'react', 'oxc'],
      categories: {
        correctness: 'error',
      },
      env: {
        builtin: true,
        browser: true,
      },
      ignorePatterns: [
        '.repos/**',
        'data/**',
        'dist/**',
        'packages/pdf/wasm/**',
        'src/routeTree.gen.ts',
      ],
      rules: {
        'no-case-declarations': 'error',
        'no-empty-static-block': 'error',
        'no-fallthrough': 'error',
        'no-regex-spaces': 'error',
        'no-useless-escape': 'error',
        'no-var': 'error',
        'prefer-const': 'error',
        'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
        'import/first': 'error',
        'import/no-commonjs': 'error',
        'import/no-duplicates': 'error',
        'typescript/ban-ts-comment': [
          'error',
          {
            'ts-expect-error': false,
            'ts-ignore': 'allow-with-description',
          },
        ],
        'typescript/consistent-type-imports': [
          'error',
          {
            prefer: 'type-imports',
          },
        ],
        'typescript/method-signature-style': ['error', 'property'],
        'typescript/no-inferrable-types': [
          'error',
          {
            ignoreParameters: true,
          },
        ],
        'typescript/no-namespace': 'error',
        'typescript/prefer-as-const': 'error',
        'react/react-in-jsx-scope': 'off',
        'react/purity': 'warn',
        'react/set-state-in-effect': 'warn',
        'vite-plus/prefer-vite-plus-imports': 'error',
      },
      // Type checking belongs to `tsc-rs` (`vp run typecheck`), which is much
      // faster; linting stays syntactic.
      options: {
        reportUnusedDisableDirectives: 'error',
        typeAware: false,
        typeCheck: false,
      },
      jsPlugins: [
        {
          name: 'vite-plus',
          specifier: 'vite-plus/oxlint-plugin',
        },
      ],
    },
    resolve: {
      tsconfigPaths: true,
      alias: workers
        ? [
            {
              find: /^#\/platform\/(.*)$/,
              replacement: fileURLToPath(
                new URL('./src/platform/cloudflare/$1.ts', import.meta.url),
              ),
            },
          ]
        : [],
    },
    // `vp run dev` binds to the Tailscale address. Allow the MagicDNS name and
    // Cloudflare quick tunnels too; Vite rejects unknown Host headers by default.
    server: { allowedHosts: ['.ts.net', '.trycloudflare.com'] },
    plugins: lazyPlugins(() => [
      // Vite forwards browser errors to the terminal. Piping server logs back to
      // the browser creates a feedback loop that can fill the disk with logs.
      devtools({ consolePiping: { enabled: false } }),
      tailwindcss(),
      ...(workers ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
      tanstackStart(),
      viteReact(),
    ]),
  }
})

export default config
