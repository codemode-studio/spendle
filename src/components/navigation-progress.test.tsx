// @vitest-environment jsdom
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { NavigationProgress } from './navigation-progress'

/** The first load resolves; every reload after it stays pending. */
function testRouter() {
  let loads = 0
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <NavigationProgress />
        <Outlet />
      </>
    ),
  })
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: () => (loads++ === 0 ? null : new Promise<never>(() => {})),
    component: () => <p>home</p>,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

function bar(container: HTMLElement) {
  const element = container.querySelector('[aria-hidden="true"]')
  if (!element) throw new Error('progress bar not rendered')
  return element
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('NavigationProgress', () => {
  it('hydrates server markup rendered while the router is pending, then shows during navigation', async () => {
    const serverRouter = testRouter()
    await serverRouter.load()
    void serverRouter.invalidate()
    expect(serverRouter.state.status).toBe('pending')
    const html = renderToString(<RouterProvider router={serverRouter} />)

    const container = document.createElement('div')
    container.innerHTML = html
    document.body.append(container)
    expect(bar(container).className).toContain('scale-x-0')

    // A hydrating Start client commits its router to `idle` before React
    // hydrates; settle the client router the same way.
    const clientRouter = testRouter()
    const settled = render(<RouterProvider router={clientRouter} />)
    await waitFor(() => expect(clientRouter.state.status).toBe('idle'))
    settled.unmount()

    const consoleError = vi.spyOn(console, 'error')
    await act(async () => {
      hydrateRoot(container, <RouterProvider router={clientRouter} />, {
        onRecoverableError: (error) => console.error(error),
      })
    })
    const hydrationErrors = consoleError.mock.calls.filter((call) =>
      call.some((arg) => /hydrat/i.test(String(arg))),
    )
    expect(hydrationErrors).toEqual([])
    expect(bar(container).className).toContain('scale-x-0')

    act(() => {
      void clientRouter.invalidate()
    })
    await waitFor(() =>
      expect(bar(container).className).toContain('scale-x-100'),
    )
  })
})
