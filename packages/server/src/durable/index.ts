// What the Cloudflare Worker builds its Durable Objects from. Nothing here
// depends on the Workers runtime: the objects pass in their storage.
export { makeControlObject } from './ControlObject.ts'
export type { ControlObject } from './ControlObject.ts'
export { makeSpaceObject } from './SpaceObject.ts'
export type { SpaceObject } from './SpaceObject.ts'
export type { RemoteSpaces } from '../spaces/SpaceGateway.ts'
