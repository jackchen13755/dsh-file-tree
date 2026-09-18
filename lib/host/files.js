/**
 * Workspace filesystem for dsh-file-tree.
 *
 * Every path the browser sends is relative to the session's workspace and is
 * re-validated here: `resolveWithin` canonicalises it (symlinks included) and
 * refuses anything that leaves the workspace root, so a link pointing outside,
 * a `../` segment or an absolute path all fail closed.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveWithin } from './fence.js';
/** Directory names never listed: noise, and huge in every real project. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache']);
/** Extensions previewed as an inline image rather than as text. */
const IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    // SVG is text, but it is previewed as a picture: served as a data URL inside
    // an <img>, where scripts cannot run — unlike inlining the markup.
    svg: 'image/svg+xml',
};
function extensionOf(name) {
    const index = name.lastIndexOf('.');
    return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}
/**
 * Resolve a caller-supplied relative path inside the workspace.
 * @param workspace - the session's working directory (the fence).
 * @param relative - `/`-separated path relative to it; empty means the root.
 * @returns the canonical absolute path, or null when it escapes or does not exist.
 */
export function resolvePath(workspace, relative) {
    const cleaned = relative.trim().replace(/^\/+/, '');
    if (cleaned.split('/').some(segment => segment === '..'))
        return null;
    const candidate = cleaned === '' ? workspace : join(workspace, cleaned);
    if (!isAbsolute(candidate))
        return null;
    return resolveWithin(workspace, candidate);
}
/**
 * List one directory.
 * @param workspace - workspace root.
 * @param relative - directory path relative to the root.
 * @param limit - maximum entries returned (directories first, then files, both by name).
 */
export async function listDirectory(workspace, relative, limit) {
    const target = resolvePath(workspace, relative);
    if (target === null)
        return null;
    const dirents = await readdir(target, { withFileTypes: true }).catch(() => null);
    if (dirents === null)
        return null;
    const entries = [];
    for (const dirent of dirents) {
        const name = dirent.name;
        const childRelative = relative.trim() === '' ? name : `${relative.replace(/\/+$/, '')}/${name}`;
        const dir = dirent.isDirectory();
        if (dir && SKIP_DIRECTORIES.has(name))
            continue;
        // A symlink is listed, but only when it actually resolves inside the workspace.
        const resolved = resolvePath(workspace, childRelative);
        if (resolved === null)
            continue;
        const info = await stat(resolved).catch(() => null);
        if (info === null)
            continue;
        entries.push({
            name,
            path: childRelative,
            dir: info.isDirectory(),
            size: info.isDirectory() ? 0 : info.size,
            mtime: Math.round(info.mtimeMs),
        });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const truncated = entries.length > limit;
    return { path: relative.trim(), entries: truncated ? entries.slice(0, limit) : entries, truncated };
}
/**
 * Read a file for preview: text (capped), image (base64 data URL), or a refusal.
 * @param workspace - workspace root.
 * @param relative - file path relative to the root.
 * @param textLimit - byte ceiling for text previews.
 * @param imageLimit - byte ceiling for image previews.
 */
export async function readPreview(workspace, relative, textLimit, imageLimit) {
    const target = resolvePath(workspace, relative);
    if (target === null)
        return null;
    const info = await stat(target).catch(() => null);
    if (info === null || !info.isFile())
        return null;
    const mime = IMAGE_MIME[extensionOf(relative)];
    if (mime !== undefined) {
        if (info.size > imageLimit)
            return { path: relative, size: info.size, kind: 'too-large', mime };
        const bytes = await readFile(target);
        return { path: relative, size: info.size, kind: 'image', mime, content: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    const bytes = await readFile(target).catch(() => null);
    if (bytes === null)
        return null;
    // A NUL byte in the leading window is the classic "this is not text" signal.
    if (bytes.subarray(0, 4096).includes(0))
        return { path: relative, size: info.size, kind: 'binary' };
    const slice = bytes.subarray(0, textLimit);
    return {
        path: relative,
        size: info.size,
        kind: 'text',
        content: slice.toString('utf8'),
        truncated: bytes.length > slice.length,
    };
}
/**
 * Bounded recursive name search: breadth-first, skipping noise directories.
 * @param workspace - workspace root.
 * @param query - case-insensitive substring matched against the basename.
 * @param limit - maximum hits.
 * @param maxDepth - directory depth ceiling.
 */
export async function searchFiles(workspace, query, limit, maxDepth) {
    const needle = query.trim().toLowerCase();
    if (needle === '')
        return [];
    const hits = [];
    let frontier = [''];
    for (let depth = 0; depth <= maxDepth && frontier.length > 0 && hits.length < limit; depth += 1) {
        const next = [];
        for (const directory of frontier) {
            const listed = await listDirectory(workspace, directory, 2000);
            if (listed === null)
                continue;
            for (const entry of listed.entries) {
                if (entry.name.toLowerCase().includes(needle)) {
                    hits.push(entry);
                    if (hits.length >= limit)
                        break;
                }
                if (entry.dir)
                    next.push(entry.path);
            }
            if (hits.length >= limit)
                break;
        }
        frontier = next;
    }
    return hits;
}
/** Extensions tried, in order, when a specifier omits one. */
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte', '.py', '.md', '.css', '.scss'];
/** Directory index files tried when the specifier names a directory. */
const RESOLVE_INDEXES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs', 'index.json', '__init__.py'];
/**
 * Resolve a module specifier written inside one workspace file to another file
 * in the same workspace.
 *
 * Only relative specifiers are resolved: a bare package name would need
 * node_modules resolution and a TypeScript program, which this panel does not
 * pretend to be. Containment is re-checked on the result, so `../../..` cannot
 * escape the workspace even though the specifier came from file content.
 *
 * @param workspace - workspace root.
 * @param from - the file the specifier was written in (workspace-relative).
 * @param specifier - the raw specifier, e.g. `./api` or `../util/index.js`.
 * @returns the resolved workspace-relative path, or null with a reason.
 */
export async function resolveSpecifier(workspace, from, specifier) {
    const raw = specifier.trim();
    if (raw === '')
        return { path: null, reason: 'empty' };
    if (!raw.startsWith('./') && !raw.startsWith('../') && !raw.startsWith('/')) {
        return { path: null, reason: 'bare-specifier' };
    }
    const fromDirectory = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const segments = `${fromDirectory}/${raw}`.split('/');
    const normalized = [];
    for (const segment of segments) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (normalized.length === 0)
                return { path: null, reason: 'escapes-workspace' };
            normalized.pop();
            continue;
        }
        normalized.push(segment);
    }
    const base = normalized.join('/');
    // Candidates in the order a module resolver tries them: the specifier as
    // written, then with each known extension appended (`./b` → `./b.ts`), then
    // with its own extension REPLACED (`./b.js` → `./b.ts`) — the ESM-in-TypeScript
    // spelling that appending alone can never produce.
    const slash = base.lastIndexOf('/');
    const dot = base.lastIndexOf('.');
    const stem = dot > slash ? base.slice(0, dot) : base;
    const candidates = new Set([base]);
    for (const extension of RESOLVE_EXTENSIONS)
        candidates.add(`${base}${extension}`);
    if (dot > slash)
        for (const extension of RESOLVE_EXTENSIONS)
            candidates.add(`${stem}${extension}`);
    for (const candidate of candidates) {
        if (candidate === '')
            continue;
        if (resolvePath(workspace, candidate) !== null)
            return { path: candidate };
    }
    for (const index of RESOLVE_INDEXES) {
        const candidate = `${base}/${index}`;
        if (resolvePath(workspace, candidate) !== null)
            return { path: candidate };
    }
    return { path: null, reason: 'not-found' };
}
//# sourceMappingURL=files.js.map