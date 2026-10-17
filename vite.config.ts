import { defineConfig, loadEnv, lazyPlugins } from 'vite-plus'
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
        // Type-aware rules that only flag safe patterns here: `String()` on
        // FormData fields and spreading Schema.Class values into read models.
        'typescript/no-base-to-string': 'off',
        'typescript/no-duplicate-type-constituents': 'off',
        'typescript/no-misused-spread': 'off',
        'typescript/require-array-sort-compare': 'off',
        'typescript/restrict-template-expressions': 'off',
        'vite-plus/prefer-vite-plus-imports': 'error',
      },
      options: {
        typeAware: true,
        typeCheck: true,
      },
      jsPlugins: [
        {
          name: 'vite-plus',
          specifier: 'vite-plus/oxlint-plugin',
        },
      ],
    },
    resolve: { tsconfigPaths: true },
    // `vp run dev` binds to the Tailscale address. Allow the MagicDNS name too;
    // Vite rejects unknown Host headers by default.
    server: { allowedHosts: ['.ts.net'] },
    plugins: lazyPlugins(() => [
      // Vite forwards browser errors to the terminal. Piping server logs back to
      // the browser creates a feedback loop that can fill the disk with logs.
      devtools({ consolePiping: { enabled: false } }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ]),
  }
})

export default config
