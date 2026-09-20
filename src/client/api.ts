/**
 * Typed client for the host's `/dsh-file-tree/*` route.
 *
 * Every call carries the session id and a workspace-relative path; the host
 * resolves the workspace itself, so the panel cannot reach outside the
 * directory the session sits in.
 */

/** One directory row. */
export interface EntryInfo {
  readonly name: string
  readonly path: string
  readonly dir: boolean
  readonly size: number
  readonly mtime: number
}

/** A directory listing. */
export interface Listing {
  readonly path: string
  readonly entries: readonly EntryInfo[]
  readonly truncated: boolean
}

/** A file preview: text, an inline image, or a refusal worth explaining. */
export interface Preview {
  readonly path: string
  readonly size: number
  readonly kind: 'text' | 'image' | 'binary' | 'too-large'
  readonly content?: string
  readonly truncated?: boolean
  readonly mime?: string
}

/** Host-side caps, echoed so both halves agree. */
export interface PanelOptions {
  readonly readLimitBytes: number
  readonly imageLimitBytes: number
  readonly listLimit: number
  readonly searchLimit: number
}

/** Resolution of the session's workspace. */
export interface ContextValue {
  readonly workspace: string
  readonly options: PanelOptions
}

/** One code-server workbench, as the host reports it. */
export interface EditorInstance {
  readonly id: string
  readonly workspace: string
  readonly state: 'starting' | 'ready' | 'failed'
  readonly port: number
  readonly url: string
  readonly error?: string
  readonly note?: string
  readonly version?: string
}

/** The embedded-editor half of the panel: off, starting, ready, or explained. */
export interface EditorStatus {
  readonly enabled: boolean
  readonly instance?: EditorInstance
  readonly instances?: readonly EditorInstance[]
}

/** An operation failure carrying the host's explanation. */
export class FilePanelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FilePanelError'
    this.code = code
  }
}

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; detail?: string }
}

/**
 * Call one operation.
 * @param operation - route suffix: `context`, `list`, `read`, `search`, `editor`.
 * @param sessionId - the session the panel is drawn in.
 * @param fields - operation parameters (`path`, `query`, `specifier`, `start`).
 */
export async function call<T>(
  operation: string,
  sessionId: string,
  fields: { path?: string; query?: string; specifier?: string; start?: boolean } = {},
): Promise<T> {
  const response = await fetch(`/dsh-file-tree/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...fields }),
  })
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    throw new FilePanelError('bad-response', `the host answered ${response.status} without JSON`)
  }
  if (envelope.ok !== true || envelope.value === undefined) {
    const error = envelope.error ?? { code: 'unknown', message: 'the operation failed' }
    throw new FilePanelError(error.code, error.detail === undefined ? error.message : `${error.message}\n${error.detail}`)
  }
  return envelope.value
}
