/**
 * Opening a file the way the product does it: a `dsh-resource://file/...`
 * address handed to the right sidebar's controller, which routes it to whatever
 * tab type claims it (in a stock profile that is the shipped document preview —
 * the same surface a file link in the conversation opens).
 *
 * The address builder is a faithful port of the product's own
 * `sessionFileAddress` (util/workspace-path): segment-encoded, `:` left literal
 * for Windows drive letters, backslashes normalised, leading `./` dropped.
 */

/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Encode a `/`-separated path segment by segment. */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

/**
 * Build the address of a file read through one session.
 * @param sessionId - the session whose host workspace resolves the path.
 * @param path - absolute or workspace-relative path.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/** The controller face this plugin uses; only `openResource` is required. */
export interface SidebarRightLike {
  openResource(address: string, options?: { revealIfOpened?: boolean }): void
}

/** What an open attempt did, for the panel's notice line. */
export interface OpenResult {
  readonly ok: boolean
  readonly address: string
  readonly reason?: string
}

/**
 * Open one workspace file in a native sidebar tab (the shipped preview).
 * @param controller - `ctx.get('sidebarRight')`, probed at call time.
 * @param sessionId - the session the panel is drawn in.
 * @param path - workspace-relative path.
 */
export function openFileInTab(
  controller: SidebarRightLike | undefined,
  sessionId: string,
  path: string,
): OpenResult {
  const address = sessionFileAddress(sessionId, path)
  if (controller === undefined || typeof controller.openResource !== 'function') {
    return { ok: false, address, reason: '当前 DSH 没有提供侧栏控制器，已改用行内预览' }
  }
  try {
    controller.openResource(address, { revealIfOpened: true })
    return { ok: true, address }
  } catch (error) {
    return { ok: false, address, reason: String((error as Error)?.message ?? error) }
  }
}

/**
 * A grammar hint for the official `CodeBlock`, from the file extension.
 * @param path - workspace-relative or absolute file path.
 * @returns a shiki language id, or undefined for plain text.
 */
export function languageForPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const byExtension: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'jsonc',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'fish',
    ps1: 'powershell',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    vue: 'vue',
    svelte: 'svelte',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'docker',
    diff: 'diff',
    patch: 'diff',
    csv: 'csv',
    txt: undefined as unknown as string,
  }
  if (name === 'dockerfile') return 'docker'
  if (name === 'makefile') return 'make'
  const language = byExtension[ext]
  return language === undefined || language === '' ? undefined : language
}
