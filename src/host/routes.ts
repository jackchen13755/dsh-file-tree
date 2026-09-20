/**
 * HTTP surface of dsh-file-tree: one loopback-only, session-scoped prefix route.
 *
 * The browser half names a SESSION, never a path outside it: the host resolves
 * the session's working directory and every requested path is canonicalised and
 * containment-checked against it (see `files.resolvePath`). Same envelope shape
 * as the rest of this author's plugins — `{ok:true,value}` / `{ok:false,error}`
 * — so the caller has one code path and no route can be triggered by a link.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { isLoopback, sessionRoot } from './fence.js'
import { aliasTable } from './aliases.js'
import { listDirectory, readPreview, resolveSpecifier, searchFiles } from './files.js'
import { webServerOf } from './services.js'
import { CODE_SERVER_PREFIX, ensureInstance, listInstances, viewFor, type CodeServerInstance, type CodeServerOptions } from './code-server.js'
import { proxyHttp } from './proxy.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-file-tree'

/** Limits the panel also reads back, so both halves agree on the caps. */
export interface RouteOptions {
  readonly readLimitBytes: number
  readonly imageLimitBytes: number
  readonly listLimit: number
  readonly searchLimit: number
  /** code-server knobs, or undefined when the embedded editor is switched off. */
  readonly codeServer?: CodeServerOptions
}

type Failure = { ok: false; error: { code: string; message: string; detail?: string } }
type Outcome = { ok: true; value: unknown } | Failure

interface RequestBody {
  readonly sessionId?: unknown
  readonly path?: unknown
  readonly query?: unknown
  readonly from?: unknown
  readonly specifier?: unknown
  readonly start?: unknown
}

const MAX_BODY_BYTES = 64 * 1024

function fail(code: string, message: string, detail?: string): Failure {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function readBody(request: IncomingMessage): Promise<RequestBody | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as RequestBody) : null
  } catch {
    return null
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}

/**
 * Mount the plugin's HTTP surface.
 *
 * Two routes, because they have nothing in common: one JSON API under
 * `/dsh-file-tree/*` for the tree, previews and search, and one reverse-proxy
 * route under `/dsh-file-tree/code-server/*` that carries an embedded VS Code
 * workbench. The web server matches the longest prefix, so the second route
 * takes precedence for its own subtree and neither can shadow the other.
 *
 * @param ctx - host context (needs `webServer` and `sessions`).
 * @param options - resolved plugin configuration, echoed back to the browser half.
 * @returns disposer removing both routes.
 */
export function registerRoutes(ctx: Context, options: RouteOptions): () => void {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!isLoopback(request)) {
        send(response, 403, fail('forbidden', 'dsh-file-tree is loopback-only'))
        return
      }
      if (request.method !== 'POST') {
        send(response, 405, fail('method', 'POST required'))
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const operation = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : ''
      if (operation === '' || operation.includes('/')) {
        send(response, 404, fail('not-found', 'unknown route'))
        return
      }
      const body = await readBody(request)
      if (body === null) {
        send(response, 400, fail('bad-body', 'a JSON body is required'))
        return
      }
      const sessionId = str(body.sessionId)
      if (sessionId === '') {
        send(response, 400, fail('no-session', 'sessionId is required'))
        return
      }
      const workspace = sessionRoot(ctx, sessionId)
      if (workspace === undefined) {
        send(response, 403, fail('unknown-session', 'the session has no working directory'))
        return
      }
      const relative = str(body.path)

      switch (operation) {
        case 'context': {
          send(response, 200, { ok: true, value: { workspace, options } })
          return
        }
        case 'list': {
          const listed = await listDirectory(workspace, relative, options.listLimit)
          if (listed === null) {
            send(response, 404, fail('not-a-directory', `cannot list: ${relative === '' ? '.' : relative}`))
            return
          }
          send(response, 200, { ok: true, value: listed })
          return
        }
        case 'read': {
          const preview = await readPreview(workspace, relative, options.readLimitBytes, options.imageLimitBytes)
          if (preview === null) {
            send(response, 404, fail('not-a-file', `cannot read: ${relative}`))
            return
          }
          send(response, 200, { ok: true, value: preview })
          return
        }
        case 'resolve': {
          // Aliases come from the workspace's own config (tsconfig paths, webpack
          // resolve.alias) so project-internal specifiers resolve like the build does.
          const resolved = await resolveSpecifier(workspace, relative, str(body.specifier), await aliasTable(workspace))
          send(response, 200, { ok: true, value: resolved })
          return
        }
        case 'search': {
          const query = str(body.query)
          const hits = await searchFiles(workspace, query, options.searchLimit, 6)
          send(response, 200, { ok: true, value: { query, hits } })
          return
        }
        case 'editor': {
          const editor = await codeServerStatus(workspace, body, options)
          send(response, 200, { ok: true, value: editor })
          return
        }
        default:
          send(response, 404, fail('unknown-op', `unknown operation: ${operation}`))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(error instanceof Error ? error : new Error(message))
      if (!response.headersSent) send(response, 500, fail('internal', message))
      else response.end()
    }
  }

  const disposers: Array<() => void> = [webServerOf(ctx).register({ kind: 'prefix', path: ROUTE_PREFIX, handler })]
  // The reverse-proxy route is registered separately so its subtree wins the
  // longest-prefix match, and so a profile with the editor switched off never
  // sees the route at all.
  if (options.codeServer !== undefined) {
    const codeServerOptions = options.codeServer
    disposers.push(
      webServerOf(ctx).register({
        kind: 'prefix',
        path: CODE_SERVER_PREFIX,
        handler: (request, response) => {
          if (!isLoopback(request)) {
            refuse(response)
            return
          }
          if (!proxyHttp(request, response, new URL(request.url ?? '/', 'http://x').pathname)) {
            refuse(response)
          }
        },
      }),
    )
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Refuse a request that reached the proxy but is not allowed to use it. */
function refuse(response: ServerResponse): void {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('dsh-file-tree is loopback-only')
}

/**
 * Status of the embedded editor for one workspace, starting it when asked.
 *
 * `start: false` is a pure read: the panel polls with it so a workbench that is
 * still booting does not get a second one launched beside it.
 *
 * @param workspace - the session's working directory.
 * @param body - the request fields (`start`).
 * @param options - resolved plugin configuration.
 */
async function codeServerStatus(
  workspace: string,
  body: RequestBody,
  options: RouteOptions,
): Promise<
  | { readonly enabled: false }
  | { readonly enabled: true; readonly instance?: CodeServerInstance; readonly instances: readonly CodeServerInstance[] }
> {
  const configured = options.codeServer
  if (configured === undefined) return { enabled: false }
  const wantStart = body.start === undefined ? true : body.start !== false
  if (wantStart) {
    const instance = await ensureInstance(workspace, configured)
    return { enabled: true, instance, instances: listInstances() }
  }
  const known = listInstances().find(candidate => candidate.workspace === workspace)
  const instance = known === undefined ? undefined : (viewFor(known.id) ?? known)
  return instance === undefined ? { enabled: true, instances: listInstances() } : { enabled: true, instance, instances: listInstances() }
}
