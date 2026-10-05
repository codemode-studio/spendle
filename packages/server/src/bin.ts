import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Layer from 'effect/Layer'

import { ServerConfig } from './config.ts'
import { ServerLive } from './server.ts'

ServerLive.pipe(
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
)
