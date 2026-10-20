import { bindings, defineConfig, exports } from 'cf/config'

// The production Worker (`vp run build`, `cf deploy`): TanStack Start serves
// the web app and the API runs in Durable Objects beside it, one per family
// space plus the control object. `vp run dev` stays on Node; see
// `vite.config.ts`. The account comes from `CLOUDFLARE_ACCOUNT_ID` or the
// signed-in `cf` profile.
const origin = 'https://spendle.codemode.studio'

export default defineConfig(({ mode }) => {
  // `--mode qa` builds the same Worker for a local run with synthetic secrets
  // from `.dev.vars.qa` (README, "Publicar"): no domain, its own origin, the QA
  // sign-in link, and no Pluggy webhook.
  const qa = mode === 'qa'
  const name = qa ? 'spendle-qa' : 'spendle'
  return {
    worker: {
      name,
      entrypoint: './packages/cloudflare/src/worker.ts',
      compatibilityDate: '2026-10-01',
      // TanStack Start and Better Auth need Node's APIs; the flag also fills
      // `process.env` from the variables and secrets below.
      compatibilityFlags: ['nodejs_compat'],
      // Served only on its own domain: Better Auth signs people in on
      // `BETTER_AUTH_URL`, so a workers.dev copy would only show the sign-in.
      domains: qa ? [] : [new URL(origin).hostname],
      workersDev: false,
      // D1 and both Durable Objects live in the eastern US (the objects in
      // IAD and EWR; D1 has no South American region), so the Worker runs
      // beside them: a request crosses the continent once instead of on
      // every session read and API call. Static assets stay at the edge.
      placement: qa ? undefined : { region: 'aws:us-east-1' },
      observability: { enabled: true, traces: { enabled: true } },
      exports: {
        Control: exports.durableObject({ storage: 'sqlite' }),
        Space: exports.durableObject({ storage: 'sqlite' }),
      },
      env: {
        AUTH_DB: bindings.d1({
          name: 'spendle-auth',
          id: '93cb58c6-43df-47b6-b77d-6201d20dbe1c',
        }),
        CONTROL: bindings.durableObject({
          worker: name,
          exportName: 'Control',
        }),
        SPACES: bindings.durableObject({ worker: name, exportName: 'Space' }),
        CF_VERSION_METADATA: bindings.versionMetadata(),
        BETTER_AUTH_URL: qa ? bindings.secret() : bindings.text(origin),
        PLUGGY_WEBHOOK_URL:
          !qa && bindings.text(`${origin}/api/pluggy/webhook`),
        OPENROUTER_MODEL: bindings.text('openai/gpt-6-luna'),
        SPENDLE_QA_SIGN_IN_TOKEN: qa && bindings.secret(),
        // Values live in Cloudflare; see "Publicar" in the README.
        BETTER_AUTH_SECRET: bindings.secret(),
        BETTER_AUTH_API_KEY: bindings.secret(),
        GOOGLE_CLIENT_ID: bindings.secret(),
        GOOGLE_CLIENT_SECRET: bindings.secret(),
        SPENDLE_ALLOWED_EMAILS: bindings.secret(),
        PLUGGY_CLIENT_ID: bindings.secret(),
        PLUGGY_CLIENT_SECRET: bindings.secret(),
        PLUGGY_WEBHOOK_SECRET: !qa && bindings.secret(),
        TYPESAFE_API_KEY: bindings.secret(),
        OPENROUTER_API_KEY: bindings.secret(),
      },
    },
  }
})
