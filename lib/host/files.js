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
import { aliasCandidates, topLevelDirectories } from './aliases.js';
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
/** Directory entry files tried when the specifier names a directory. */
const RESOLVE_INDEXES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.vue', 'index.mjs', 'index.cjs', 'index.json', '__init__.py'];
/**
 * Resolve a module specifier written inside one workspace file to another FILE
 * in the same workspace.
 *
 * Sources, in order: a relative path (`./x`, `../x`), a workspace-absolute path,
 * the workspace's alias table (tsconfig `paths`, webpack `resolve.alias`), the
 * workspace root itself, then the source roots (`src`, webpack `resolve.modules`).
 * Each base is tried as-is, with each known extension appended, with its own
 * extension REPLACED (`./b.js` → `./b.ts`), and finally as a directory whose
 * `index.*` is the target — the shape `import x from './DropWrapper'` relies on.
 *
 * Only regular files are returned: a specifier that names a directory resolves to
 * that directory's index file or fails, never to the directory itself.
 *
 * @param workspace - workspace root.
 * @param from - the file the specifier was written in (workspace-relative).
 * @param specifier - the raw specifier, e.g. `./api` or `isomorph/components/X`.
 * @param table - the workspace's alias table (see `aliases.ts`).
 * @returns the resolved workspace-relative path plus the rule that matched, or a reason.
 */
export async function resolveSpecifier(workspace, from, specifier, table) {
    const raw = specifier.trim();
    if (raw === '')
        return { path: null, reason: 'empty' };
    const bases = [];
    const relative = raw.startsWith('./') || raw.startsWith('../');
    if (relative) {
        const fromDirectory = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
        bases.push({ base: normalizeFrom(fromDirectory, raw), rule: '相对路径' });
    }
    else if (raw.startsWith('/')) {
        bases.push({ base: raw.replace(/^\/+/, ''), rule: '工作区绝对路径' });
    }
    else {
        for (const candidate of aliasCandidates(raw, table)) {
            bases.push({ base: candidate.base, rule: candidate.source });
        }
        // A specifier whose first segment is a real top-level directory of this
        // workspace (`isomorph/...`) resolves there directly.
        const head = raw.split('/')[0] ?? '';
        if (head !== '' && (await topLevelDirectories(workspace)).has(head)) {
            bases.push({ base: raw, rule: '工作区顶层目录' });
        }
        bases.push({ base: raw, rule: '工作区相对' });
    }
    for (const { base, rule } of bases) {
        const normalized = normalizeFrom('', base);
        if (normalized === '' || normalized.split('/').includes('..'))
            continue;
        const resolved = await resolveBase(workspace, normalized);
        if (resolved !== null)
            return { path: resolved, rule };
    }
    return { path: null, reason: raw.split('/').length === 1 ? 'bare-specifier' : 'not-found' };
}
/** Collapse `.`/`..` segments of `directory/specifier`; empty when it escapes. */
function normalizeFrom(directory, specifier) {
    const segments = `${directory}/${specifier}`.split('/');
    const out = [];
    for (const segment of segments) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (out.length === 0)
                return '';
            out.pop();
            continue;
        }
        out.push(segment);
    }
    return out.join('/');
}
/** The first candidate of one base that exists as a regular file. */
async function resolveBase(workspace, base) {
    const slash = base.lastIndexOf('/');
    const dot = base.lastIndexOf('.');
    const stem = dot > slash ? base.slice(0, dot) : base;
    const candidates = new Set([base]);
    for (const extension of RESOLVE_EXTENSIONS) {
        if (extension !== '')
            candidates.add(`${base}${extension}`);
    }
    if (dot > slash)
        for (const extension of RESOLVE_EXTENSIONS)
            candidates.add(`${stem}${extension}`);
    for (const candidate of candidates) {
        if (candidate === '' || (await fileStatus(workspace, candidate)) === 'file') {
            if (candidate !== '')
                return candidate;
        }
    }
    for (const index of RESOLVE_INDEXES) {
        const candidate = `${base}/${index}`;
        if ((await fileStatus(workspace, candidate)) === 'file')
            return candidate;
    }
    return null;
}
/** `file`, `directory` or `missing`, resolved inside the workspace. */
async function fileStatus(workspace, candidate) {
    const absolute = resolvePath(workspace, candidate);
    if (absolute === null)
        return 'missing';
    const info = await stat(absolute).catch(() => null);
    if (info === null)
        return 'missing';
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'missing';
}
//# sourceMappingURL=files.js.map