# Working in this repository

The web app in `src/` (TanStack Start routes, components, hooks and server functions) reads and writes everything through the API in `packages/server`, the only backend. The V1 server, its Drizzle database, its domain logic and the migration of its data were removed; do not reintroduce financial rules, database access or provider calls in `src/`.

- Verify user-visible changes end to end yourself before delivery; do not hand the developer an "untested in a browser" list. Follow [browser QA](.agents/skills/browser-qa/SKILL.md): an isolated `vp run qa:start` run, signed in through its QA link, driven with T3 Code's Browser panel (`preview_*` tools), and `vp run qa:mcp` for MCP changes. Never use the developer's running server or data for this, and do not add an E2E framework.
- Use `vp run setup:check` after setup. Follow the focused verification guidance below; CI owns `vp run verify`.
- For concurrent worktrees, run `node scripts/setup-worktree.ts` (or let the t3.json "Setup Worktree" action run it) to install with `vp install --frozen-lockfile` and link the main checkout's `.env.local`. `vp run qa:start` picks free ports for the worktree and runs the app against an in-memory QA API with synthetic data and a fake Pluggy. Do not share `data/`, SQLite WAL files, or imported sources between runs.
- Server functions in `src/features/data/*.functions.ts` validate input with `Schema.toStandardSchemaV1` and call the API through `src/lib/api/client.server.ts`; the browser never reaches the API. Their validators and query keys are functional boundaries, not redundant wrappers. Tests that need the API use `src/test/api.ts`, which serves the real API routes in memory.
- When a screen needs data the API does not expose, add the endpoint in `packages/server` with a server test instead of computing it in `src/`. `src/lib` holds presentation helpers only (formatting, periods, presets).
- Preserve centavo precision, immutable imported facts, zero-difference import gating, both transfer sides, and frozen closed-budget allocations; those rules live in the server and are tested there.
- Category learning comes only from a person's decision; in the UI, route category choices and recurrence confirmations to the API's decision endpoints, never to heuristics or model output.
- Scope UI types to the read model they need. Invalidation of financial reads includes configuration, planning, categories and paginated transactions; optimistic category edits must also cover cached transaction pages.
- Sign-in is Google through Better Auth in `src/features/auth`, limited to `SPENDLE_ALLOWED_EMAILS`. Better Auth keeps people, sessions and OAuth clients in its own database (a SQLite file in `data/auth/` on Node, the D1 `spendle-auth` on Cloudflare; never financial data) and creates its tables on first use. `src/start.ts` requires an allowed session for every server function; route `beforeLoad` only guards pages. A new server route that touches data must call `readViewer()` itself. QA runs keep real auth: `vp run qa:start` registers a sign-in link for `qa@spendle.local` (`SPENDLE_QA_SIGN_IN_TOKEN`), which nothing else sets.
- The MCP server (`/api/mcp`, `src/features/mcp`) is Better Auth's OAuth provider plus resource: a client signs in through `/entrar`, the person approves it on `/autorizar`, and each call re-checks the allowlist before calling the API as that member. Tools read, refresh and sync Open Finance. Only a token with the `spendle:write` scope, which the person grants on `/autorizar`, also gets the write tools; they record the person's decisions (categories, notes, one-off marks, transfers, category rules, caps, pausing recurrences) through the same API endpoints as the app, and the tools tell the client to call them only when the person asks.
- AI features (assistant, model classifier) are on by default when the server has their keys; there is no separate consent step. Model output never unlocks an import or teaches categories.

## Production on Cloudflare

- Production is one Cloudflare Worker ([ADR 004](plans/adrs/004-cloudflare-workers.md)): `vp run build` builds it from `cloudflare.config.ts`, and the `Deploy` workflow ships `main`. `vp run dev`, QA and tests stay on Node.
- Code that differs by runtime lives in `src/platform/*.server.ts` (Node) with a twin in `src/platform/cloudflare/` that `vite.config.ts` swaps in on build, both typed by `src/platform/types.ts`. Keep the rest of `src/` runtime-neutral.
- `packages/server/src/durable` builds the Durable Objects from the same services; it and everything it imports must not reach Node-only modules (`spaces/LocalSpaces.ts`, `persistence/Sqlite.ts`, `@effect/platform-node`, `node:*`). `packages/cloudflare` holds the object classes and the Worker, typed against the Workers runtime.
- Check a change that touches the Worker, the objects or `src/platform` in the local Workers runtime with the `qa` mode in the README's "Publicar" section, besides the Node QA run.

## Development and process safety

- Inspect existing dev servers before starting another. Reuse a suitable running instance for authorized read-only checks when its worktree and data are appropriate; do not restart or reconfigure the developer's active environment.
- Mutating verification uses isolated synthetic data and fake providers. Never point a QA server at the developer's database or import sources. Start a separate QA run only when the authorized check needs it.
- Track processes when starting them. Stop only your own captured process or a port owner whose working directory you have confirmed. Never kill processes by name or worktree pattern. Stop what you started before delivery unless asked to leave it running.
- Use the `vp` CLI ([Vite+](https://viteplus.dev)) for every project command: `vp install`, `vp run <script>` (or `vpr <script>`), `vp test`, `vp lint`, `vp fmt` and `vp build`. Do not call `pnpm`, `npx`, `vitest`, `oxlint` or `oxfmt` directly; pnpm is only the package manager `vp` drives. Keep pinned dependencies. Development scripts should make required services clear; do not silently change ports, origins or shared environment files.

## Verification

- Choose the smallest proof that covers the change: `vp test run <files>` from the root for web tests, and from `packages/server` for server tests.
- Lint and format with Oxc through Vite+; the `lint` and `fmt` sections of `vite.config.ts` cover the web app and `packages/server`. Check changed files with `vp lint <files>` and `vp fmt --check <files>`; `vp run fmt` formats and applies lint fixes. Run `git diff --check` before delivery. Lint is syntactic; type checking is `tsc-rs`, a native port of TypeScript 7 with the Effect diagnostics built in. Keep `typescript`, `@effect/tsgo` and the `effect-tsgo patch` prepare step for editors, with `@effect/tsgo` on the version `tsc-rs` ports (see the catalog). For code changes, run the affected package's typecheck: `vp run typecheck` for web or `vp run --filter @spendle/server typecheck` for server. Shared API contract changes need both.
- Do not run repo-wide tests, builds or `vp run verify` unless the developer asks. CI runs the full gate. Broaden focused checks only when failures or a concrete cross-module risk require it, and explain why.
- Test meaningful behavior and independent contracts. Backend behavior changes ship with focused tests. Do not add static-markup, prop, callback-wiring or source-text assertions that merely mirror the implementation. A logo, copy or styling change normally needs no new unit test.
- Check all affected entry points and states, including desktop and mobile layouts, loading, empty, error and reverse actions where relevant. The primary agent runs the browser pass once on the integrated result; delegated workers do not each start servers.
- Report checks actually run, failures and unverified behavior separately. Do not describe automated tests as browser coverage. Only what QA cannot reach stays unverified (a real Google account, real Pluggy, production); say why.

## Implementation and documentation

- Prefer the smallest model that makes correct behavior clear. Keep policy in pure domain code, complexity at adapters, transports thin and UI concerned with presentation. Preserve performance when fetching, invalidating, rendering lists or adding motion.
- Shared UI components own their appearance. Use their variants and sizes; add a shared variant only for a shared concept. Feature-specific styling stays with the feature. Prefer inferred types and avoid `any`.
- Update documentation when usage, a durable decision or a constraint changes. Do not add feature inventories, implementation transcripts or PR summaries. Explain local reasoning in a nearby comment; rewrite outdated guidance instead of appending a competing account.

## Backend (`packages/server`)

The backend is an Effect 4 server with its own SQLite databases (`data/v2/`, a name kept from the migration); see [ADR 003](plans/adrs/003-backend-v2-effect.md).

- Run `vp run sync:effect-docs` once, then read `.repos/effect/LLMS.md` before writing Effect code. `.repos/` holds read-only references matching the pinned version; prefer their patterns over invented ones, never import from them, and resync when bumping `effect`.
- Effect 4 stable ships SQL, HTTP and testing as `effect/sql`, `effect/http`, `effect/http-api` and `effect/testing`. Older `effect/unstable/*` examples (including T3 Code's) need translating.
- Import modules by namespace: `import * as Effect from 'effect/Effect'`. Services are `class X extends Context.Service<X, Shape>()('@spendle/server/<path>/X')` with a static `layer`; implement methods with `Effect.fn('X.method')`. Errors are `Schema.TaggedError` with the context needed to act on them.
- Use `Clock`/`DateTime`, `Random`, `HttpClient`, `FileSystem` and `Path` services instead of globals or Node built-ins, and `Schema` instead of `JSON.parse` or hand-written guards. `vp run --filter @spendle/server typecheck` runs the Effect diagnostics that enforce this.
- Every piece of data belongs to a family space, and each space has its own SQLite database, services and reactors (`src/spaces/Space.ts`, built per space through `SpaceApps`). The front router in `src/spaces/Routes.ts` resolves the `x-spendle-member` email to its space; `SpaceDirectory` owns the control database of spaces and members. Domain code stays unaware of spaces: never query across spaces or keep data outside a space's database. Wire new services into `spaceServices`, and keep server-wide pieces (Pluggy client, webhook registration, `SpaceWebhooks`, which stores each delivery before routing it to its spaces) in `server.ts` and, for the Worker, `durable/ControlObject.ts` and `durable/Platform.ts`. Spaces are reached through `SpaceGateway`: built in-process by `LocalSpaces` on Node, one Durable Object each on Cloudflare. `ApiTest` and the QA server serve a single space.
- Persistence uses `SqlClient` with tagged-template queries and `SqlSchema` decoding. Migrations are statically imported in `src/persistence/Migrations.ts`, append-only, and never edited after merge.
- Facts observed from banks and files are immutable; human decisions are durable; everything else is a projection that can be rebuilt from those two. A matcher or categorizer improvement must be able to rerun over history.
- Tests use `@effect/vitest` (`it.effect`, `layer`) with `Sqlite.layerMemory`, not mocked repositories. Async flows expose a drain or receipt to wait on; a test that needs a sleep or timeout is wrong. Backend behavior changes ship with focused tests for that behavior, testing outcomes rather than mirroring the implementation.
- Complexity belongs at adapter boundaries (Pluggy, file parsers, AI). Matching and categorization policy stays pure and testable without I/O.
- PDF text comes from `packages/pdf`: pdf-inspector's Rust core compiled to WebAssembly, with the generated `wasm/` committed so nothing else needs Rust. Rebuild it as its README describes; never edit `wasm/` by hand.
- The web API lives in `src/api/`. `definition/` is the contract the web app imports (`@spendle/server/api`): only `effect` imports, read-model schemas of its own, every endpoint declaring `EndpointErrors`. Handlers stay thin: call a domain service, shape the response, and end with `respond('<group>.<endpoint>')`, which maps domain errors to the `{ _tag, reason, detail }` body; add a new domain error's mapping in `Failures.ts`. Cross-module reads go in `ReadModel.ts`; writes go through the owning service. Test endpoints through `testing/ApiTest.ts` (real socket, typed client, every reactor) and `drain` before reading projections.
- Category learning: `KnowledgeStore` is the only writer of `category_patterns`, and only a person's decision (`Categorizer.decide`/`confirm`/`correct`) or store edit teaches it; reconciliation, refunds, provider categories and model answers never do. Inferences are a projection: change `categories/Policy.ts` and bump `POLICY_VERSION` instead of migrating them. The model classifier (GPT-6 Luna through OpenRouter, `Classifier.makeOpenRouter`) stays disabled without `OPENROUTER_API_KEY`; tests use `testing/FakeClassifier.ts`, and `vp run --filter @spendle/server eval:models` compares other models before a switch.

## UI e UX autoexplicativas

- Em cada área, componente e estado, a pessoa deve reconhecer o que está vendo, o que pode fazer e o resultado da ação pela hierarquia visual, posição, ícones, gráficos e feedback.
- Prefira gráficos e indicadores para comparações, progresso, limites e metas. Use rótulos curtos para distinguir valores, períodos e realizado versus previsto; remova legendas e parágrafos que apenas repetem o que o elemento já comunica.
- Análises do assistente aparecem junto ao conteúdo relevante com o ícone de brilhos, sem rótulos como `Análise do assistente · IA` e sem um card interno só para o texto. Use espaçamento e tipografia para organizar o conteúdo.
- Preserve nomes acessíveis nos controles de ícone, navegação por teclado e identificação dos estados além da cor. Mensagens de erro ou ausência de dados devem indicar uma ação útil.
- Quando a verificação de UI for autorizada, confira cada elemento afetado em desktop e celular: propósito, ação, estado e resultado precisam ser compreensíveis sem uma explicação externa. Corrija a apresentação antes de acrescentar texto de ajuda.

<!-- intent-skills:start -->

# TanStack Intent - before editing files, run the matching guidance command.

tanstackIntent:

- id: "@tanstack/devtools#devtools-app-setup"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools#devtools-app-setup"
  for: "Install TanStack Devtools, pick framework adapter (React/Vue/Solid/Preact), register plugins via plugins prop, configure shell (position, hotkeys, theme, hideUntilHover, requireUrlFlag, eventBusConfig). TanStackDevtools component, defaultOpen, localStorage persistence."
- id: "@tanstack/devtools#devtools-marketplace"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools#devtools-marketplace"
  for: "Publish plugin to npm and submit to TanStack Devtools Marketplace. PluginMetadata registry format, plugin-registry.ts, pluginImport (importName, type), requires (packageName, minVersion), framework tagging, multi-framework submissions, featured plugins."
- id: "@tanstack/devtools#devtools-plugin-panel"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools#devtools-plugin-panel"
  for: "Build devtools panel components that display emitted event data. Listen via EventClient.on(), handle theme (light/dark), use @tanstack/devtools-ui components. Plugin registration (name, render, id, defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins. Two paths: Solid.js core with devtools-ui for multi-framework support, or framework-specific panels."
- id: "@tanstack/devtools#devtools-production"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools#devtools-production"
  for: "Handle devtools in production vs development. removeDevtoolsOnBuild, devDependency vs regular dependency, conditional imports, NoOp plugin variants for tree-shaking, non-Vite production exclusion patterns."
- id: "@tanstack/devtools-event-client#devtools-bidirectional"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-bidirectional"
  for: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
- id: "@tanstack/devtools-event-client#devtools-event-client"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-event-client"
  for: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
- id: "@tanstack/devtools-event-client#devtools-instrumentation"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools-event-client#devtools-instrumentation"
  for: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
- id: "@tanstack/devtools-vite#devtools-vite-plugin"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/devtools-vite#devtools-vite-plugin"
  for: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
- id: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/react-start#lifecycle/migrate-from-nextjs"
  for: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
- id: "@tanstack/react-start#react-start"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/react-start#react-start"
  for: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
- id: "@tanstack/react-start#react-start/server-components"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/react-start#react-start/server-components"
  for: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
- id: "@tanstack/router-core#router-core"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core"
  for: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
- id: "@tanstack/router-core#router-core/auth-and-guards"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/auth-and-guards"
  for: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
- id: "@tanstack/router-core#router-core/code-splitting"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/code-splitting"
  for: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
- id: "@tanstack/router-core#router-core/data-loading"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/data-loading"
  for: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
- id: "@tanstack/router-core#router-core/navigation"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/navigation"
  for: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
- id: "@tanstack/router-core#router-core/not-found-and-errors"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/not-found-and-errors"
  for: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
- id: "@tanstack/router-core#router-core/path-params"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/path-params"
  for: "Dynamic path segments ($paramName), splat routes ($ / _splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
- id: "@tanstack/router-core#router-core/search-params"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/search-params"
  for: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
- id: "@tanstack/router-core#router-core/ssr"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/ssr"
  for: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
- id: "@tanstack/router-core#router-core/type-safety"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-core#router-core/type-safety"
  for: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
- id: "@tanstack/router-plugin#router-plugin"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/router-plugin#router-plugin"
  for: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
- id: "@tanstack/start-client-core#start-core"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core"
  for: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
- id: "@tanstack/start-client-core#start-core/auth-server-primitives"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/auth-server-primitives"
  for: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, __Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
- id: "@tanstack/start-client-core#start-core/deployment"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/deployment"
  for: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
- id: "@tanstack/start-client-core#start-core/execution-model"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/execution-model"
  for: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE_ prefix, process.env)."
- id: "@tanstack/start-client-core#start-core/middleware"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/middleware"
  for: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
- id: "@tanstack/start-client-core#start-core/server-functions"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/server-functions"
  for: "createServerFn (GET/POST), validator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
- id: "@tanstack/start-client-core#start-core/server-routes"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/server-routes"
  for: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
- id: "@tanstack/start-server-core#start-server-core"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/start-server-core#start-server-core"
  for: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
- id: "@tanstack/virtual-file-routes#virtual-file-routes"
  run: "pnpm dlx @tanstack/intent@latest load @tanstack/virtual-file-routes#virtual-file-routes"
  for: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."

<!-- intent-skills:end -->
