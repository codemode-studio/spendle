import type * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import * as Sink from 'effect/Sink'
import * as Etag from 'effect/http/Etag'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpEffect from 'effect/http/HttpEffect'
import type * as HttpMiddleware from 'effect/http/HttpMiddleware'
import * as HttpPlatform from 'effect/http/HttpPlatform'
import type * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { ApiConfig } from '../api/ApiConfig.ts'
import { PluggyClient } from '../openfinance/PluggyClient.ts'
import { WebhookConfig } from '../openfinance/WebhookConfig.ts'

/**
 * Uploads in memory: a Durable Object has no disk, and multipart parsing
 * writes each file to a request-scoped temporary directory before the
 * handler reads it back. Only those three operations are supported; the
 * directory and its files are dropped when the request ends.
 */
const memoryFileSystem = Layer.sync(FileSystem.FileSystem, () => {
  const files = new Map<string, Array<Uint8Array>>()
  let directories = 0
  return FileSystem.makeNoop({
    makeTempDirectoryScoped: () =>
      Effect.acquireRelease(
        Effect.sync(() => `/uploads/${++directories}`),
        (directory) =>
          Effect.sync(() => {
            for (const path of files.keys()) {
              if (path.startsWith(`${directory}/`)) files.delete(path)
            }
          }),
      ),
    sink: (path) =>
      Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          const chunks = files.get(path)
          if (chunks === undefined) files.set(path, [chunk])
          else chunks.push(chunk)
        }),
      ),
    readFile: (path) => {
      const chunks = files.get(path)
      if (chunks === undefined) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: 'NotFound',
            module: 'FileSystem',
            method: 'readFile',
            pathOrDescriptor: path,
          }),
        )
      }
      const bytes = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.length, 0),
      )
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return Effect.succeed(bytes)
    },
  })
})

// Configured once per object from the Worker's environment; Node builds the
// same set in `server.ts`.
const ServerWide = Layer.mergeAll(
  ApiConfig.layer,
  WebhookConfig.layer,
  PluggyClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
)

// The Web Crypto API every Workers runtime provides.
const webCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(await crypto.subtle.digest(algorithm, data)),
        catch: (cause) =>
          PlatformError.badArgument({
            module: 'Crypto',
            method: 'digest',
            cause,
          }),
      }),
  }),
)

/** What the Node services provide to the server, for a Durable Object. */
export const layer = Layer.mergeAll(
  HttpPlatform.layer,
  Etag.layerWeak,
  ServerWide,
).pipe(
  Layer.provideMerge(Layer.mergeAll(memoryFileSystem, webCrypto, Path.layer)),
)

/**
 * A Web `Request` handler for `app`, run with the services in `context`.
 * The request and its scope are the only services the app may add.
 */
export const webHandler = <Provided, E, R>(
  context: Context.Context<Provided>,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  middleware?: HttpMiddleware.HttpMiddleware,
) => HttpEffect.toWebHandlerWith<Provided, R>(context)(app, middleware)
