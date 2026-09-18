/**
 * Workspace filesystem for dsh-file-tree.
 *
 * Every path the browser sends is relative to the session's workspace and is
 * re-validated here: `resolveWithin` canonicalises it (symlinks included) and
 * refuses anything that leaves the workspace root, so a link pointing outside,
 * a `../` segment or an absolute path all fail closed.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { resolveWithin } from './fence.js'

/** One row of a directory listing. */
export interface EntryInfo {
  /** Basename. */
  readonly name: string
  /** Path relative to the workspace root, `/`-separated. */
  readonly path: string
  readonly dir: boolean
  readonly size: number
  /** Epoch milliseconds of the last modification. */
  readonly mtime: number
}

/** Directory names never listed: noise, and huge in every real project. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache'])

/** Extensions previewed as an inline image rather than as text. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase()
}

/**
 * Resolve a caller-supplied relative path inside the workspace.
 * @param workspace - the session's working directory (the fence).
 * @param relative - `/`-separated path relative to it; empty means the root.
 * @returns the canonical absolute path, or null when it escapes or does not exist.
 */
export function resolvePath(workspace: string, relative: string): string | null {
  const cleaned = relative.trim().replace(/^\/+/, '')
  if (cleaned.split('/').some(segment => segment === '..')) return null
  const candidate = cleaned === '' ? workspace : join(workspace, cleaned)
  if (!isAbsolute(candidate)) return null
  return resolveWithin(workspace, candidate)
}

/**
 * List one directory.
 * @param workspace - workspace root.
 * @param relative - directory path relative to the root.
 * @param limit - maximum entries returned (directories first, then files, both by name).
 */
export async function listDirectory(
  workspace: string,
  relative: string,
  limit: number,
): Promise<{ path: string; entries: EntryInfo[]; truncated: boolean } | null> {
  const target = resolvePath(workspace, relative)
  if (target === null) return null
  const dirents = await readdir(target, { withFileTypes: true }).catch(() => null)
  if (dirents === null) return null
  const entries: EntryInfo[] = []
  for (const dirent of dirents) {
    const name = dirent.name
    const childRelative = relative.trim() === '' ? name : `${relative.replace(/\/+$/, '')}/${name}`
    const dir = dirent.isDirectory()
    if (dir && SKIP_DIRECTORIES.has(name)) continue
    // A symlink is listed, but only when it actually resolves inside the workspace.
    const resolved = resolvePath(workspace, childRelative)
    if (resolved === null) continue
    const info = await stat(resolved).catch(() => null)
    if (info === null) continue
    entries.push({
      name,
      path: childRelative,
      dir: info.isDirectory(),
      size: info.isDirectory() ? 0 : info.size,
      mtime: Math.round(info.mtimeMs),
    })
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  const truncated = entries.length > limit
  return { path: relative.trim(), entries: truncated ? entries.slice(0, limit) : entries, truncated }
}

/** Result of reading a file for preview. */
export interface FilePreview {
  readonly path: string
  readonly size: number
  readonly kind: 'text' | 'image' | 'binary' | 'too-large'
  /** Text content for `text`; a `data:` URL for `image`. */
  readonly content?: string
  readonly truncated?: boolean
  readonly mime?: string
}

/**
 * Read a file for preview: text (capped), image (base64 data URL), or a refusal.
 * @param workspace - workspace root.
 * @param relative - file path relative to the root.
 * @param textLimit - byte ceiling for text previews.
 * @param imageLimit - byte ceiling for image previews.
 */
export async function readPreview(
  workspace: string,
  relative: string,
  textLimit: number,
  imageLimit: number,
): Promise<FilePreview | null> {
  const target = resolvePath(workspace, relative)
  if (target === null) return null
  const info = await stat(target).catch(() => null)
  if (info === null || !info.isFile()) return null
  const mime = IMAGE_MIME[extensionOf(relative)]
  if (mime !== undefined) {
    if (info.size > imageLimit) return { path: relative, size: info.size, kind: 'too-large', mime }
    const bytes = await readFile(target)
    return { path: relative, size: info.size, kind: 'image', mime, content: `data:${mime};base64,${bytes.toString('base64')}` }
  }
  const bytes = await readFile(target).catch(() => null)
  if (bytes === null) return null
  // A NUL byte in the leading window is the classic "this is not text" signal.
  if (bytes.subarray(0, 4096).includes(0)) return { path: relative, size: info.size, kind: 'binary' }
  const slice = bytes.subarray(0, textLimit)
  return {
    path: relative,
    size: info.size,
    kind: 'text',
    content: slice.toString('utf8'),
    truncated: bytes.length > slice.length,
  }
}

/**
 * Bounded recursive name search: breadth-first, skipping noise directories.
 * @param workspace - workspace root.
 * @param query - case-insensitive substring matched against the basename.
 * @param limit - maximum hits.
 * @param maxDepth - directory depth ceiling.
 */
export async function searchFiles(
  workspace: string,
  query: string,
  limit: number,
  maxDepth: number,
): Promise<EntryInfo[]> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: EntryInfo[] = []
  let frontier: string[] = ['']
  for (let depth = 0; depth <= maxDepth && frontier.length > 0 && hits.length < limit; depth += 1) {
    const next: string[] = []
    for (const directory of frontier) {
      const listed = await listDirectory(workspace, directory, 2000)
      if (listed === null) continue
      for (const entry of listed.entries) {
        if (entry.name.toLowerCase().includes(needle)) {
          hits.push(entry)
          if (hits.length >= limit) break
        }
        if (entry.dir) next.push(entry.path)
      }
      if (hits.length >= limit) break
    }
    frontier = next
  }
  return hits
}
