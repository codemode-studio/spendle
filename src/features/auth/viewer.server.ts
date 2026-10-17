import { v2Space } from '#/lib/v2/client.server'

import { readViewer } from './auth.server'
import type { Viewer } from './viewer'

/**
 * The signed-in person with the id of their family space, for the page and
 * `/api/viewer`. A space that cannot be read (data not claimed yet, the API
 * down) leaves `spaceId` null instead of failing the page.
 */
export async function readViewerWithSpace(): Promise<Viewer | null> {
  const person = await readViewer()
  if (person === null) return null
  const spaceId = await v2Space((client) => client.space.get()).then(
    (space) => space.id,
    () => null,
  )
  return { ...person, spaceId }
}
