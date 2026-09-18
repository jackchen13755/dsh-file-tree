window.__ModuleLoader__.load({
	id: "dsh-file-tree",
	factory: (require) => {
		var __factories = [];
		var __cache = {};
		function __require(id) {
			if (__cache[id] === undefined) __cache[id] = __factories[id]();
			return __cache[id];
		}
__factories[0] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * Typed client for the host's `/dsh-file-tree/*` route.
 *
 * Every call carries the session id and a workspace-relative path; the host
 * resolves the workspace itself, so the panel cannot reach outside the
 * directory the session sits in.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FilePanelError = void 0;
exports.call = call;
/** An operation failure carrying the host's explanation. */
class FilePanelError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'FilePanelError';
        this.code = code;
    }
}
exports.FilePanelError = FilePanelError;
/**
 * Call one operation.
 * @param operation - route suffix: `context`, `list`, `read`, `search`.
 * @param sessionId - the session the panel is drawn in.
 * @param fields - operation parameters (`path`, `query`, `specifier`).
 */
async function call(operation, sessionId, fields = {}) {
    const response = await fetch(`/dsh-file-tree/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...fields }),
    });
    let envelope;
    try {
        envelope = (await response.json());
    }
    catch {
        throw new FilePanelError('bad-response', `the host answered ${response.status} without JSON`);
    }
    if (envelope.ok !== true || envelope.value === undefined) {
        const error = envelope.error ?? { code: 'unknown', message: 'the operation failed' };
        throw new FilePanelError(error.code, error.detail === undefined ? error.message : `${error.message}\n${error.detail}`);
    }
    return envelope.value;
}

return module.exports;
};
__factories[1] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const panel_js_1 = __require(3);
const tab_js_1 = __require(5);
/** Registration identity shared by the tab registry and the body slot. */
const TYPE_ID = 'dsh-file-tree:files';
/** Tab kind that `openTab` names. */
const KIND = 'files';
/** `slots` is the only service needed before the first render. */
exports.inject = ['slots'];
/**
 * Register the tab type, its body, and the guide entry that opens it.
 * @param ctx - client context.
 */
function apply(ctx) {
    ctx.inject(['sidebarRightTabs'], injected => {
        const tabs = injected.get('sidebarRightTabs');
        if (tabs === undefined)
            return undefined;
        return tabs.register({
            id: TYPE_ID,
            kind: KIND,
            title: () => '文件面板',
            guide: [
                {
                    id: 'files',
                    order: 20,
                    title: () => '文件面板',
                    description: () => '工作区文件树 + 预览 + @文件引用',
                },
            ],
        });
    });
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TYPE_ID,
        inject: (sessionId) => ({
            sessionId,
            // Probing the controller per open keeps this plugin working on a
            // profile whose sidebar is composed differently.
            openResource: (path, line) => (0, tab_js_1.openFileInTab)(ctx.get('sidebarRight'), sessionId, path, line),
        }),
    }, (props) => (0, panel_js_1.FilePanel)(props))), 'dsh-file-tree: panel body');
}

return module.exports;
};
__factories[2] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * Ctrl/Cmd-click navigation inside the panel's preview.
 *
 * Two kinds of jump, both resolved from what the user actually clicked:
 *
 * - a **module specifier** (`./api.js`, `../util/index`) is resolved by the host
 *   against the workspace and opened — in a native tab, at line 1;
 * - an **identifier** is looked up in the file's own text and the view scrolls
 *   to the first plausible declaration, flashing that line.
 *
 * Cross-file symbol resolution (a TypeScript program, node_modules) is out of
 * scope on purpose: guessing there would be worse than saying so.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.specifierLike = specifierLike;
exports.findDeclarationLine = findDeclarationLine;
exports.wordAtPoint = wordAtPoint;
exports.importedFrom = importedFrom;
exports.quotedSpecifierOn = quotedSpecifierOn;
exports.lineElements = lineElements;
exports.lineIndexOf = lineIndexOf;
exports.revealLine = revealLine;
exports.trackJumpAffordance = trackJumpAffordance;
exports.memberReceiver = memberReceiver;
/** Quoted strings and bare path-looking words, e.g. `./a`, `../b/c.ts`, `src/app/x.tsx`. */
function specifierLike(token) {
    const trimmed = token.trim().replace(/^['"`]|['"`]$/g, '');
    if (trimmed === '' || /\s/.test(trimmed))
        return undefined;
    if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/'))
        return trimmed;
    // A path-shaped string inside the workspace: has a slash and a known-looking suffix.
    if (/^[\w.-]+(\/[\w.-]+)+$/.test(trimmed))
        return trimmed;
    // A quoted bare name is a package: hand it to the host so the panel can say
    // "that is a package, not a workspace file" instead of "no definition found".
    if (/^['"`]/.test(token.trim()) && /^[@\w][\w./@-]*$/.test(trimmed))
        return trimmed;
    return undefined;
}
/** Declaration shapes searched for, most specific first. */
function declarationPatterns(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = `\\b${escaped}\\b`;
    return [
        new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${boundary}`),
        new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${boundary}`),
        new RegExp(`\\b(?:export\\s+)?interface\\s+${boundary}`),
        new RegExp(`\\b(?:export\\s+)?type\\s+${boundary}\\s*[=<]`),
        new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${boundary}`),
        new RegExp(`\\b(?:export\\s+)?enum\\s+${boundary}`),
        // Class member / method / object property / parameter.
        new RegExp(`^\\s*(?:public|private|protected|readonly|static|async|get|set|\\*)?\\s*${boundary}\\s*[(?]`),
        new RegExp(`^\\s*${boundary}\\s*[:=]`),
    ];
}
/**
 * First line that plausibly declares `name`, 1-based.
 * @param lines - the file's lines.
 * @param name - the clicked identifier.
 */
function findDeclarationLine(lines, name) {
    if (name === '')
        return undefined;
    for (const pattern of declarationPatterns(name)) {
        for (let index = 0; index < lines.length; index += 1) {
            if (pattern.test(lines[index] ?? ''))
                return index + 1;
        }
    }
    return undefined;
}
/** Escape a string for use inside a RegExp. */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Characters that make up a file path or an identifier. */
const WORD_CHARACTER = /[\w$./@\\-]/;
/**
 * The word under a viewport point.
 *
 * Reading the clicked ELEMENT's text is not enough: a highlighter is free to
 * wrap a whole line in one span (that is exactly what the product's CodeBlock
 * does), which would hand a symbol jump the entire line. The caret API asks the
 * document what character is actually under the cursor.
 *
 * @param x - viewport x (from the mouse event).
 * @param y - viewport y.
 * @returns the word under the point, or undefined when the point is not on text.
 */
function wordAtPoint(x, y) {
    const doc = document;
    let node = null;
    let offset = 0;
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range !== null && range !== undefined) {
        node = range.startContainer;
        offset = range.startOffset;
    }
    else {
        const position = doc.caretPositionFromPoint?.(x, y);
        if (position !== null && position !== undefined) {
            node = position.offsetNode;
            offset = position.offset;
        }
    }
    if (node === null || node.nodeType !== 3)
        return undefined;
    const text = node.textContent ?? '';
    if (text === '')
        return undefined;
    // Expand around the caret to the surrounding path/identifier characters.
    let start = Math.min(offset, text.length);
    let end = start;
    while (start > 0 && WORD_CHARACTER.test(text[start - 1] ?? ''))
        start -= 1;
    while (end < text.length && WORD_CHARACTER.test(text[end] ?? ''))
        end += 1;
    let word = text.slice(start, end);
    // Adjacent quotes are part of a specifier's presentation, not of its value.
    word = word.replace(/^['"`]+|['"`]+$/g, '').replace(/[.,;:]+$/g, '');
    return word === '' ? undefined : word;
}
/** The element that wraps one rendered source line, inside a CodeBlock-like body. */
/**
 * The specifier a name is imported from, when the file binds it with a relative
 * import or require — the one cross-file case this panel can follow honestly.
 * @param lines - the file's lines.
 * @param name - the clicked identifier.
 * @returns the raw specifier, or undefined when the name is not imported.
 */
function importedFrom(lines, name) {
    const wanted = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    for (const line of lines) {
        const statement = /^\s*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/.exec(line);
        if (statement === null)
            continue;
        if (wanted.test(statement[1] ?? ''))
            return statement[2];
        // `import './side-effect'` binds nothing.
    }
    for (const line of lines) {
        const required = new RegExp(`\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${escapeRegExp(name)}\\b[^}]*\\}|[\\w$]+)\\s*=\\s*require\\(['"]([^'"]+)['"]\\)`);
        const match = required.exec(line);
        if (match !== null && wanted.test(line))
            return match[1];
    }
    return undefined;
}
/**
 * The first relative path quoted on a line — a fallback for syntax highlighters
 * that split a string literal into several tokens, so the clicked token alone no
 * longer looks like a path.
 * @param lineText - the rendered line's text.
 */
function quotedSpecifierOn(lineText) {
    const match = /['"`](\.\.?\/[^'"`]+)['"`]/.exec(lineText);
    return match === null ? undefined : match[1];
}
/** The element that wraps one rendered source line, inside a CodeBlock-like body. */
function lineElements(container) {
    const content = container.querySelector('[data-code-block-content]') ?? container;
    const byAttribute = [...content.querySelectorAll('[data-textpreview-line]')];
    if (byAttribute.length > 0)
        return byAttribute;
    const byClass = [...content.querySelectorAll('.line')];
    if (byClass.length > 0)
        return byClass;
    const pre = content.querySelector('pre');
    if (pre !== null) {
        const children = [...pre.children].filter((child) => child instanceof HTMLElement);
        if (children.length > 1)
            return children;
    }
    const code = content.querySelector('code');
    if (code !== null) {
        const children = [...code.children].filter((child) => child instanceof HTMLElement);
        if (children.length > 1)
            return children;
    }
    return [];
}
/**
 * The rendered line index (1-based) that contains an element, or undefined.
 * @param container - the preview body.
 * @param element - the clicked token element.
 */
function lineIndexOf(container, element) {
    const elements = lineElements(container);
    if (elements.length === 0)
        return undefined;
    let node = element;
    while (node !== null) {
        const index = elements.indexOf(node);
        if (index >= 0)
            return index + 1;
        node = node.parentElement;
    }
    return undefined;
}
/**
 * Scroll a line into view and flash it, so a same-file jump is visible.
 * @param container - the scrollable preview body.
 * @param line - 1-based line number.
 * @returns whether that line is rendered.
 */
function revealLine(container, line) {
    const target = lineElements(container)[line - 1];
    if (target === undefined)
        return false;
    target.scrollIntoView({ block: 'center' });
    const previous = target.style.backgroundColor;
    const previousTransition = target.style.transition;
    target.style.transition = 'background-color 120ms ease-in';
    target.style.backgroundColor = 'var(--dsw-alias-bg-3, rgba(77,107,254,.28))';
    setTimeout(() => {
        target.style.backgroundColor = previous;
        target.style.transition = previousTransition;
    }, 900);
    return true;
}
/**
 * Underline the token under a Ctrl/Cmd-held cursor, so jumpable targets are
 * visible before the click. Returns a disposer that clears the highlight.
 * @param container - the preview body.
 */
function trackJumpAffordance(container) {
    let highlighted;
    const clear = () => {
        if (highlighted !== undefined) {
            highlighted.style.textDecoration = '';
            highlighted.style.cursor = '';
            highlighted = undefined;
        }
    };
    const onMove = (event) => {
        if (!event.ctrlKey && !event.metaKey) {
            clear();
            return;
        }
        const target = event.target?.closest('span');
        if (target === null || (target.textContent ?? '').trim() === '') {
            clear();
            return;
        }
        if (highlighted === target)
            return;
        clear();
        highlighted = target;
        target.style.textDecoration = 'underline';
        target.style.cursor = 'pointer';
    };
    const onLeave = () => clear();
    const onKeyUp = () => clear();
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    window.addEventListener('keyup', onKeyUp);
    return () => {
        clear();
        container.removeEventListener('mousemove', onMove);
        container.removeEventListener('mouseleave', onLeave);
        window.removeEventListener('keyup', onKeyUp);
    };
}
/**
 * The receiver of a member access, for `obj.method()` / `this.method()` style
 * calls: what stands before the final dot.
 *
 * This is what lets a click on `doThing` in `service.doThing(1)` follow the
 * `service` import when `doThing` itself is not imported by name.
 *
 * @param lineText - the rendered line's text.
 * @param token - the clicked identifier.
 * @returns the receiver identifier, or undefined when this is not a member access.
 */
function memberReceiver(lineText, token) {
    const at = lineText.indexOf(token);
    if (at <= 0)
        return undefined;
    let index = at - 1;
    while (index >= 0 && /\s/.test(lineText[index] ?? ''))
        index -= 1;
    if (lineText[index] !== '.')
        return undefined;
    index -= 1;
    if (lineText[index] === '?')
        index -= 1;
    const end = index + 1;
    while (index >= 0 && /[\w$]/.test(lineText[index] ?? ''))
        index -= 1;
    const receiver = lineText.slice(index + 1, end);
    return receiver === '' ? undefined : receiver;
}

return module.exports;
};
__factories[3] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FilePanel = FilePanel;
/**
 * The file panel: a workspace tree with an inline preview, drawn in a native
 * right-sidebar tab.
 *
 * Two things it deliberately does NOT do: index the workspace up front (the
 * tree is lazy, one `list` per expanded directory) and fight the shell for
 * layout (it lives entirely inside the tab body the seat hands it).
 *
 * The product's own primitives do the presentation work where they exist:
 * `FileTypeIcon` for the coloured per-type icons, `CodeBlock` for the shiki
 * coloured preview, `fileSizeText` for size copy. All three are loaded lazily
 * so a profile without `ui-primitives` degrades instead of breaking.
 */
const react_1 = require("react");
const api_js_1 = __require(0);
const reference_js_1 = __require(4);
const tab_js_1 = __require(5);
const jump_js_1 = __require(2);
let cachedPrimitives;
/** The product's UI primitives, loaded once on first use. */
function primitives() {
    if (cachedPrimitives === undefined) {
        try {
            cachedPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
        }
        catch {
            cachedPrimitives = null;
        }
    }
    return cachedPrimitives ?? {};
}
const TOKEN = {
    text: 'var(--dsw-alias-text-1, #e6e6e6)',
    dim: 'var(--dsw-alias-text-3, #9a9a9a)',
    faint: 'var(--dsw-alias-text-4, #777)',
    border: 'var(--dsw-alias-border-l2, #333)',
    hover: 'var(--dsw-alias-bg-2, rgba(255,255,255,.06))',
    selected: 'var(--dsw-alias-bg-3, rgba(77,107,254,.18))',
    rail: 'var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
    danger: 'var(--dsw-alias-danger-1, #f85149)',
    ok: 'var(--dsw-alias-success-1, #3fb950)',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
/** One indent step, shared by the rails and the row padding. */
const INDENT = 12;
const ROW_HEIGHT = 21;
/** Text of one rendered line, used by the specifier fallback. */
function containerLineText(container, line) {
    return (0, jump_js_1.lineElements)(container)[line - 1]?.textContent ?? undefined;
}
const S = {
    root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12, lineHeight: 1.45, color: TOKEN.text },
    header: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${TOKEN.border}` },
    title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    spacer: { flex: 1 },
    button: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
    iconButton: { border: 'none', background: 'transparent', color: TOKEN.dim, cursor: 'pointer', fontSize: 12, padding: '0 4px' },
    filterRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: `1px solid ${TOKEN.border}` },
    input: {
        width: '100%',
        boxSizing: 'border-box',
        background: 'rgba(0,0,0,.2)',
        color: TOKEN.text,
        border: `1px solid ${TOKEN.border}`,
        borderRadius: 4,
        padding: '3px 6px',
        fontFamily: 'inherit',
        fontSize: 12,
    },
    body: { flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 2 },
    row: {
        display: 'flex',
        alignItems: 'center',
        height: ROW_HEIGHT,
        paddingRight: 6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        borderRadius: 3,
    },
    railCell: { width: INDENT, alignSelf: 'stretch', borderLeft: `1px solid ${TOKEN.rail}` },
    chevron: { width: 14, textAlign: 'center', color: TOKEN.dim, fontSize: 10, flex: 'none' },
    iconCell: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, flex: 'none' },
    name: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' },
    dirName: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', fontWeight: 500 },
    parent: { color: TOKEN.faint, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 6, flex: '0 1 auto' },
    size: { color: TOKEN.faint, fontSize: 11, marginLeft: 6, flex: 'none', fontVariantNumeric: 'tabular-nums' },
    actions: { display: 'flex', alignItems: 'center', gap: 2, marginLeft: 4, flex: 'none' },
    previewBox: { borderTop: `1px solid ${TOKEN.border}`, display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '52%' },
    previewHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: `1px solid ${TOKEN.border}` },
    pre: {
        margin: 0,
        padding: '6px 8px',
        fontFamily: TOKEN.mono,
        fontSize: 11,
        whiteSpace: 'pre',
        overflow: 'auto',
        flex: 1,
        minHeight: 0,
        background: 'rgba(0,0,0,.18)',
    },
    notice: { padding: '6px 10px', borderTop: `1px solid ${TOKEN.border}`, whiteSpace: 'pre-wrap' },
    empty: { padding: 14, color: TOKEN.dim, textAlign: 'center' },
};
/** Official size copy when the product provides it, a local one otherwise. */
function formatSize(bytes) {
    const official = primitives().fileSizeText;
    if (typeof official === 'function') {
        try {
            return official(bytes);
        }
        catch {
            // fall through to the local formatter
        }
    }
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** Extensions the panel previews as a picture (the official preview is text-only). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
/**
 * Whether a file should be previewed as a picture rather than opened in the
 * official tab. The product's preview is a TEXT preview: it renders an image as
 * "binary file" and an SVG as XML source, so pictures are shown here instead.
 * @param path - workspace-relative path.
 */
function isImagePath(path) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    return IMAGE_EXTENSIONS.has(ext);
}
function storageKey(sessionId) {
    return `dsh-file-tree:${sessionId}`;
}
function readStored(sessionId) {
    try {
        const raw = window.sessionStorage.getItem(storageKey(sessionId));
        if (raw === null)
            return { expanded: [] };
        const parsed = JSON.parse(raw);
        return {
            expanded: Array.isArray(parsed.expanded) ? parsed.expanded.filter(item => typeof item === 'string') : [],
        };
    }
    catch {
        return { expanded: [] };
    }
}
function writeStored(sessionId, state) {
    try {
        window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(state));
    }
    catch {
        // A full or disabled sessionStorage must not break the panel.
    }
}
/** Last path segment, for showing a hit's parent directory in search results. */
function parentOf(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
}
/** Fallback glyphs, used only when the product's icons are unavailable. */
function glyphFor(entry, expandedDir) {
    if (entry.dir)
        return expandedDir ? '▾' : '▸';
    const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext))
        return '▣';
    if (['md', 'markdown'].includes(ext))
        return 'M';
    if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(ext))
        return 'J';
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'py', 'go', 'rs', 'java', 'sh'].includes(ext))
        return '{}';
    return '·';
}
/**
 * The product's coloured icon for an entry, or the local glyph as a fallback.
 * @param entry - the row's entry.
 * @param expandedDir - whether a directory row is expanded.
 */
function entryIcon(entry, expandedDir) {
    const Icon = primitives().FileTypeIcon;
    if (Icon !== undefined && !entry.dir) {
        return (0, react_1.createElement)(Icon, { path: entry.path, size: 14 });
    }
    if (Icon !== undefined) {
        // Only the product's declared kinds are valid here; the open/closed state is
        // the chevron's job, so both states use the folder glyph.
        return (0, react_1.createElement)(Icon, { kind: 'folder', size: 14 });
    }
    return (0, react_1.createElement)('span', { style: { ...S.chevron, color: TOKEN.dim } }, glyphFor(entry, expandedDir));
}
/**
 * Text preview. The product's own CodeBlock does the rendering when it is
 * available (shiki colouring, numbered gutter, copy button); otherwise a plain
 * numbered `<pre>` keeps the panel usable.
 * @param content - file text.
 * @param path - the file's path, used for the language hint.
 */
function textPreview(content, path) {
    const lines = content.split('\n');
    const shown = lines.slice(0, 3000).join('\n');
    const CodeBlock = primitives().CodeBlock;
    if (CodeBlock !== undefined) {
        return (0, react_1.createElement)('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' } }, (0, react_1.createElement)(CodeBlock, {
            code: shown,
            lang: (0, tab_js_1.languageForPath)(path),
            lineNumbers: true,
            showHeader: false,
            copyLabel: '复制',
            copiedLabel: '已复制',
        }));
    }
    const width = String(lines.length).length;
    return (0, react_1.createElement)('pre', { style: S.pre }, lines.slice(0, 3000).map((line, index) => `${String(index + 1).padStart(width, ' ')}  ${line}`).join('\n'));
}
/**
 * The file panel tab body.
 * @param props - the injected session id and the tab opener.
 */
function FilePanel(props) {
    const { sessionId, openResource } = props;
    const [context, setContext] = (0, react_1.useState)(null);
    /** Loaded directories keyed by workspace-relative path (`''` is the root); a key present means "expanded". */
    const [loaded, setLoaded] = (0, react_1.useState)({});
    const [expanding, setExpanding] = (0, react_1.useState)([]);
    const [preview, setPreview] = (0, react_1.useState)(null);
    const [filter, setFilter] = (0, react_1.useState)('');
    const [hits, setHits] = (0, react_1.useState)(null);
    const [busy, setBusy] = (0, react_1.useState)('');
    const [notice, setNotice] = (0, react_1.useState)(null);
    const [hovered, setHovered] = (0, react_1.useState)('');
    const previewBody = (0, react_1.useRef)(null);
    const busyRef = (0, react_1.useRef)(false);
    const report = (0, react_1.useCallback)((error) => {
        setNotice({
            kind: 'error',
            text: error instanceof api_js_1.FilePanelError ? error.message : String(error?.message ?? error),
        });
    }, []);
    const listDirectory = (0, react_1.useCallback)(async (path) => {
        const listing = await (0, api_js_1.call)('list', sessionId, { path });
        setLoaded(previous => ({ ...previous, [path]: listing.entries }));
        if (listing.truncated)
            setNotice({ kind: 'info', text: `${path === '' ? '工作区' : path} 条目过多，已截断显示` });
    }, [sessionId]);
    const refresh = (0, react_1.useCallback)(async () => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setBusy('读取中…');
        try {
            const info = await (0, api_js_1.call)('context', sessionId);
            setContext(info);
            const openPaths = Object.keys(loaded);
            // First load of this session: restore the directories the user had open.
            const restored = openPaths.length === 0 ? readStored(sessionId).expanded : openPaths;
            for (const path of restored.length === 0 ? [''] : ['', ...restored.filter(item => item !== '')]) {
                await listDirectory(path);
            }
        }
        catch (error) {
            report(error);
        }
        finally {
            busyRef.current = false;
            setBusy('');
        }
    }, [listDirectory, loaded, report, sessionId]);
    (0, react_1.useEffect)(() => {
        void refresh();
        // Initial load only: later refreshes are explicit.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);
    const toggleDirectory = (0, react_1.useCallback)(async (entry) => {
        if (loaded[entry.path] !== undefined) {
            setLoaded(previous => {
                const next = {};
                for (const [key, value] of Object.entries(previous)) {
                    // Drop the directory and everything nested under it.
                    if (key === entry.path || key.startsWith(`${entry.path}/`))
                        continue;
                    next[key] = value;
                }
                return next;
            });
            return;
        }
        setExpanding(previous => [...previous, entry.path]);
        try {
            await listDirectory(entry.path);
        }
        catch (error) {
            report(error);
        }
        finally {
            setExpanding(previous => previous.filter(path => path !== entry.path));
        }
    }, [listDirectory, loaded, report]);
    const openFile = (0, react_1.useCallback)(async (entry) => {
        try {
            setPreview(await (0, api_js_1.call)('read', sessionId, { path: entry.path }));
            setNotice(null);
        }
        catch (error) {
            report(error);
        }
    }, [report, sessionId]);
    /** Row click: hand the file to the product's preview tab. Falls back to the inline view. */
    const openInTab = (0, react_1.useCallback)((entry) => {
        const result = openResource(entry.path);
        if (result.ok) {
            setNotice({ kind: 'info', text: `已在标签页打开 ${entry.name}（官方预览）` });
            return;
        }
        setNotice({ kind: 'error', text: result.reason ?? '打开失败' });
    }, [openResource]);
    /**
     * Ctrl/Cmd-click inside the preview: resolve a module specifier to another
     * file, or jump to an identifier's declaration in this file.
     */
    const jumpFromPreview = (0, react_1.useCallback)((event) => {
        if (!event.ctrlKey && !event.metaKey)
            return;
        const body = previewBody.current;
        const previewPath = preview?.path;
        if (body === null || previewPath === undefined)
            return;
        // Prefer the word actually under the cursor; fall back to the element's
        // text when the browser cannot resolve a caret (e.g. a synthetic event).
        const pointed = event.clientX === undefined || event.clientY === undefined ? undefined : (0, jump_js_1.wordAtPoint)(event.clientX, event.clientY);
        const elementText = (event.target?.textContent ?? '').trim();
        const token = (pointed ?? (elementText.length <= 80 ? elementText : '')).trim();
        if (token === '')
            return;
        event.preventDefault?.();
        const line = (0, jump_js_1.lineIndexOf)(body, event.target);
        const lineText = line === undefined ? '' : (containerLineText(body, line) ?? '');
        const specifier = (0, jump_js_1.specifierLike)(token) ?? (0, jump_js_1.quotedSpecifierOn)(lineText);
        if (specifier !== undefined) {
            void (0, api_js_1.call)('resolve', sessionId, { path: previewPath, specifier })
                .then(result => {
                if (result.path === null) {
                    setNotice({
                        kind: 'error',
                        text: result.reason === 'bare-specifier'
                            ? `「${specifier}」是包名，本面板不做 node_modules 解析`
                            : `无法解析「${specifier}」（${result.reason ?? 'unknown'}）`,
                    });
                    return;
                }
                const target = result.path;
                if (isImagePath(target)) {
                    setNotice({ kind: 'info', text: `跳转到图片 ${target}（行内预览）` });
                    void openFile({ path: target, name: target, dir: false, size: 0, mtime: 0 });
                    return;
                }
                const opened = openResource(target, 1);
                setNotice(opened.ok
                    ? { kind: 'info', text: `跳转到 ${target}（标签页官方预览）` }
                    : { kind: 'error', text: opened.reason ?? '打开失败' });
            })
                .catch(report);
            return;
        }
        // Identifier, three levels: declared here, imported relatively, unknown.
        const lines = (preview?.content ?? '').split('\n');
        const declared = (0, jump_js_1.findDeclarationLine)(lines, token);
        if (declared !== undefined) {
            if (declared === line) {
                setNotice({ kind: 'info', text: `${token} 的定义就在本行` });
                return;
            }
            if ((0, jump_js_1.revealLine)(body, declared)) {
                setNotice({ kind: 'info', text: `跳到第 ${declared} 行（${token} 的定义）` });
                return;
            }
        }
        const imported = (0, jump_js_1.importedFrom)(lines, token);
        if (imported !== undefined) {
            // Follow the import: resolve it, find the declaration in the target file,
            // and open that file at that line.
            void (0, api_js_1.call)('resolve', sessionId, { path: previewPath, specifier: imported })
                .then(async (result) => {
                if (result.path === null) {
                    setNotice({ kind: 'error', text: `${token} 来自「${imported}」，但无法解析该模块` });
                    return;
                }
                const target = result.path;
                const targetLines = await (0, api_js_1.call)('read', sessionId, { path: target })
                    .then(value => (value.content ?? '').split('\n'))
                    .catch(() => []);
                const targetLine = (0, jump_js_1.findDeclarationLine)(targetLines, token);
                const opened = openResource(target, targetLine ?? 1);
                setNotice(opened.ok
                    ? {
                        kind: 'info',
                        text: targetLine === undefined
                            ? `跳转到 ${target}（${token} 由「${imported}」导入，未在目标内定位到定义）`
                            : `跳转到 ${target} 第 ${targetLine} 行（${token} 的定义）`,
                    }
                    : { kind: 'error', text: opened.reason ?? '打开失败' });
            })
                .catch(report);
            return;
        }
        // Member access: `service.doThing()` where `service` is imported — follow
        // the RECEIVER's import and look the member up in that file.
        const receiver = (0, jump_js_1.memberReceiver)(lineText, token);
        if (receiver !== undefined && receiver !== 'this') {
            const receiverSpecifier = (0, jump_js_1.importedFrom)(lines, receiver);
            if (receiverSpecifier !== undefined) {
                void (0, api_js_1.call)('resolve', sessionId, { path: previewPath, specifier: receiverSpecifier })
                    .then(async (result) => {
                    if (result.path === null) {
                        setNotice({ kind: 'error', text: `${receiver} 来自「${receiverSpecifier}」，但无法解析该模块` });
                        return;
                    }
                    const target = result.path;
                    const targetLines = await (0, api_js_1.call)('read', sessionId, { path: target })
                        .then(value => (value.content ?? '').split('\n'))
                        .catch(() => []);
                    const targetLine = (0, jump_js_1.findDeclarationLine)(targetLines, token);
                    const opened = openResource(target, targetLine ?? 1);
                    setNotice(opened.ok
                        ? {
                            kind: 'info',
                            text: targetLine === undefined
                                ? `跳转到 ${target}（${receiver}.${token} 的成员，未在目标内定位到定义）`
                                : `跳转到 ${target} 第 ${targetLine} 行（${receiver}.${token} 的定义）`,
                        }
                        : { kind: 'error', text: opened.reason ?? '打开失败' });
                })
                    .catch(report);
                return;
            }
        }
        setNotice({
            kind: 'error',
            text: receiver === undefined
                ? `没有找到「${token}」的定义（跨文件的符号解析需要语言服务，本面板只跟随相对 import）`
                : `没有找到「${token}」的定义：${receiver} 不是本文件导入的，成员定义需要语言服务`,
        });
    }, [openFile, openResource, preview, report, sessionId]);
    const reference = (0, react_1.useCallback)((path) => {
        const result = (0, reference_js_1.insertReference)(path);
        setNotice(result.ok
            ? { kind: 'info', text: `已插入 ${result.text} 到输入框` }
            : { kind: 'error', text: `插入失败：${result.reason ?? '未知原因'}` });
    }, []);
    const copyPath = (0, react_1.useCallback)((path) => {
        const absolute = context === null || path === '' ? path : `${context.workspace}/${path}`;
        void navigator.clipboard?.writeText(absolute);
        setNotice({ kind: 'info', text: `已复制 ${absolute}` });
    }, [context]);
    // Search watches the filter with a small debounce: typing must not fire a walk
    // per keystroke.
    (0, react_1.useEffect)(() => {
        const query = filter.trim();
        if (query === '') {
            setHits(null);
            return undefined;
        }
        const timer = setTimeout(() => {
            void (0, api_js_1.call)('search', sessionId, { query })
                .then(value => setHits(value.hits))
                .catch(report);
        }, 250);
        return () => clearTimeout(timer);
    }, [filter, report, sessionId]);
    // Remember the view for this session: the tab body unmounts when another tab
    // is active, and losing the expansion on every switch is disorienting.
    (0, react_1.useEffect)(() => {
        writeStored(sessionId, { expanded: Object.keys(loaded).filter(path => path !== '') });
    }, [loaded, sessionId]);
    const rows = (0, react_1.useMemo)(() => {
        const out = [];
        const walk = (dirPath, depth) => {
            for (const entry of loaded[dirPath] ?? []) {
                out.push({ entry, depth });
                if (entry.dir && loaded[entry.path] !== undefined)
                    walk(entry.path, depth + 1);
            }
        };
        walk('', 0);
        return out;
    }, [loaded]);
    /** One action chip; only rendered while its row is hovered or selected. */
    const rowAction = (label, title, run, color) => (0, react_1.createElement)('button', {
        style: color === undefined ? S.iconButton : { ...S.iconButton, color },
        title,
        onClick: (event) => {
            event.stopPropagation();
            run();
        },
    }, label);
    const renderRow = (entry, depth, showParent) => {
        const expandedDir = entry.dir && loaded[entry.path] !== undefined;
        const isSearching = entry.dir && expanding.includes(entry.path);
        const selected = preview !== null && preview.path === entry.path;
        const active = hovered === entry.path || selected;
        return (0, react_1.createElement)('div', {
            key: entry.path,
            title: entry.path,
            style: {
                ...S.row,
                paddingLeft: 6,
                background: selected ? TOKEN.selected : hovered === entry.path ? TOKEN.hover : 'transparent',
            },
            onMouseEnter: () => setHovered(entry.path),
            onMouseLeave: () => setHovered(previous => (previous === entry.path ? '' : previous)),
            onClick: () => {
                if (entry.dir) {
                    void toggleDirectory(entry);
                    return;
                }
                if (isImagePath(entry.path)) {
                    // The official preview cannot show a picture; render it here.
                    setNotice({ kind: 'info', text: `图片用行内预览显示（官方预览是文本预览）` });
                    void openFile(entry);
                    return;
                }
                openInTab(entry);
            },
        }, 
        // Indent rails: one per depth level, drawn as a faint vertical line.
        ...Array.from({ length: depth }, (_, index) => (0, react_1.createElement)('span', { key: `rail-${index}`, style: S.railCell })), (0, react_1.createElement)('span', { style: S.chevron }, entry.dir ? (expandedDir ? '▾' : '▸') : ''), (0, react_1.createElement)('span', { style: S.iconCell }, entryIcon(entry, expandedDir)), (0, react_1.createElement)('span', { style: entry.dir ? S.dirName : S.name }, entry.name), showParent && parentOf(entry.path) !== '' ? (0, react_1.createElement)('span', { style: S.parent }, parentOf(entry.path)) : null, isSearching ? (0, react_1.createElement)('span', { style: { ...S.parent, color: TOKEN.dim } }, '…') : null, (0, react_1.createElement)('span', { style: S.spacer }), entry.dir ? null : (0, react_1.createElement)('span', { style: S.size }, formatSize(entry.size)), active
            ? (0, react_1.createElement)('span', { style: S.actions }, entry.dir
                ? null
                : rowAction('▤', '在本面板内预览', () => void openFile(entry)), entry.dir ? null : rowAction('＠', `把 @${entry.path} 插入输入框`, () => reference(entry.path)), rowAction('⧉', '复制绝对路径', () => copyPath(entry.path)))
            : null);
    };
    (0, react_1.useEffect)(() => {
        const body = previewBody.current;
        if (body === null)
            return undefined;
        return (0, jump_js_1.trackJumpAffordance)(body);
    }, [preview]);
    const workspaceName = context === null ? '…' : (context.workspace.split('/').filter(Boolean).pop() ?? context.workspace);
    const previewPane = preview === null
        ? null
        : (0, react_1.createElement)('div', { style: S.previewBox }, (0, react_1.createElement)('div', { style: S.previewHead }, (0, react_1.createElement)('span', { style: S.iconCell }, entryIcon({ path: preview.path, name: preview.path, dir: false, size: preview.size, mtime: 0 }, false)), (0, react_1.createElement)('span', { style: { ...S.title, flex: 1 }, title: preview.path }, preview.path), (0, react_1.createElement)('span', { style: S.size }, formatSize(preview.size)), preview.kind === 'text' && preview.truncated === true
            ? (0, react_1.createElement)('span', { style: { ...S.size, color: TOKEN.danger } }, '已截断')
            : null, (0, react_1.createElement)('button', {
            style: S.button,
            title: isImagePath(preview.path) ? '用文本方式查看源码（官方文本预览）' : '在标签页用官方预览打开',
            onClick: () => openInTab({ path: preview.path, name: preview.path }),
        }, isImagePath(preview.path) ? '↗ 源码' : '↗ 标签打开'), (0, react_1.createElement)('button', { style: S.button, title: '把该文件引用插入输入框', onClick: () => reference(preview.path) }, '＠ 引用'), (0, react_1.createElement)('button', { style: S.iconButton, title: '复制绝对路径', onClick: () => copyPath(preview.path) }, '⧉'), (0, react_1.createElement)('button', { style: S.iconButton, title: '关闭预览', onClick: () => setPreview(null) }, '✕')), preview.kind === 'text'
            ? (0, react_1.createElement)('div', {
                ref: (element) => { previewBody.current = (element ?? null); },
                style: { flex: 1, minHeight: 0, overflow: 'auto' },
                onClick: jumpFromPreview,
                title: 'Ctrl/Cmd + 点击：跳到定义或打开 import 的文件',
            }, textPreview(preview.content ?? '', preview.path))
            : preview.kind === 'image'
                ? (0, react_1.createElement)('div', { style: { ...S.body, padding: 8, textAlign: 'center' } }, (0, react_1.createElement)('img', { src: preview.content, alt: preview.path, style: { maxWidth: '100%', maxHeight: '100%' } }))
                : (0, react_1.createElement)('div', { style: S.empty }, preview.kind === 'binary'
                    ? '二进制文件，无法以文本预览。'
                    : `文件过大（${formatSize(preview.size)}），超过预览上限。`));
    return (0, react_1.createElement)('div', { style: S.root }, (0, react_1.createElement)('div', { style: S.header }, (0, react_1.createElement)('span', { style: S.iconCell }, entryIcon({ path: '', name: workspaceName, dir: true, size: 0, mtime: 0 }, false)), (0, react_1.createElement)('span', { style: S.title, title: context?.workspace ?? '' }, workspaceName), busy === '' ? null : (0, react_1.createElement)('span', { style: { ...S.size, color: TOKEN.dim } }, busy), (0, react_1.createElement)('span', { style: S.spacer }), (0, react_1.createElement)('button', { style: S.iconButton, title: '刷新（重新读取已展开的目录）', onClick: () => void refresh() }, '↻')), (0, react_1.createElement)('div', { style: S.filterRow }, (0, react_1.createElement)('input', {
        value: filter,
        placeholder: '搜索文件名…（Esc 清空）',
        'aria-label': '搜索文件名',
        style: S.input,
        onChange: (event) => setFilter(event.target.value),
        onKeyDown: (event) => {
            if (event.key === 'Escape')
                setFilter('');
        },
    }), filter.trim() === '' ? null : (0, react_1.createElement)('span', { style: { ...S.size, whiteSpace: 'nowrap' } }, `${hits?.length ?? 0} 命中`)), (0, react_1.createElement)('div', { style: S.body, onMouseLeave: () => setHovered('') }, filter.trim() !== ''
        ? hits === null
            ? (0, react_1.createElement)('div', { style: S.empty }, '搜索中…')
            : hits.length === 0
                ? (0, react_1.createElement)('div', { style: S.empty }, `没有匹配「${filter.trim()}」的文件。`)
                : hits.map(entry => renderRow(entry, 0, true))
        : rows.length === 0
            ? (0, react_1.createElement)('div', { style: S.empty }, context === null ? '正在读取工作区…' : '这个工作区是空的。')
            : rows.map(row => renderRow(row.entry, row.depth, false))), previewPane, notice === null
        ? null
        : (0, react_1.createElement)('div', { style: { ...S.notice, color: notice.kind === 'error' ? TOKEN.danger : TOKEN.ok } }, notice.text));
}

return module.exports;
};
__factories[4] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * `@file` references: the product's grammar is plain text, so inserting one is
 * a text insertion into the composer — no private API involved.
 *
 * Format (shared with `@deepseek-ai/dsh-file-reference/grammar`):
 * `@path/to/file` normally, `@"path with spaces"` when the path needs quoting.
 * The host resolves the token against the session workspace when the message is
 * sent, which is why the panel inserts a workspace-RELATIVE path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mentionText = mentionText;
exports.findComposer = findComposer;
exports.insertReference = insertReference;
/**
 * Format a workspace-relative path as the mention text the composer accepts.
 * @param relativePath - `/`-separated path relative to the workspace root.
 */
function mentionText(relativePath) {
    return /[\s"'`]/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}
/**
 * Find the conversation composer: the visible rich-text input that is NOT part
 * of the right sidebar (where this panel lives).
 * @returns the composer element, or undefined when the conversation is not mounted.
 */
function findComposer() {
    const candidates = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter(element => element.closest('[data-rightbar-col]') === null)
        .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
    // The composer sits at the bottom of the conversation: take the lowest one.
    return candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
}
/**
 * Insert one file reference into the composer, moving the caret to the end.
 * @param relativePath - workspace-relative path to reference.
 */
function insertReference(relativePath) {
    const text = mentionText(relativePath);
    const composer = findComposer();
    if (composer === undefined)
        return { ok: false, text, reason: '没有找到输入框（会话未挂载？）' };
    composer.focus();
    const selection = window.getSelection();
    if (selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    try {
        // execCommand is the only cross-editor way to insert text so that the rich
        // editor's own model (and therefore React state) sees the change.
        const inserted = document.execCommand('insertText', false, text);
        if (inserted)
            return { ok: true, text };
    }
    catch {
        // fall through to the manual path below
    }
    try {
        const node = document.createTextNode(text);
        const selection2 = window.getSelection();
        const range2 = selection2?.rangeCount !== undefined && selection2.rangeCount > 0 ? selection2.getRangeAt(0) : null;
        if (range2 === null) {
            composer.appendChild(node);
        }
        else {
            range2.deleteContents();
            range2.insertNode(node);
            range2.collapse(false);
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return { ok: true, text };
    }
    catch (error) {
        return { ok: false, text, reason: String(error?.message ?? error) };
    }
}

return module.exports;
};
__factories[5] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionFileAddress = sessionFileAddress;
exports.openFileInTab = openFileInTab;
exports.languageForPath = languageForPath;
/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment) {
    return encodeURIComponent(segment).replace(/%3A/gi, ':');
}
/** Encode a `/`-separated path segment by segment. */
function encodePath(path) {
    return path.split('/').map(encodeSegment).join('/');
}
/**
 * Build the address of a file read through one session.
 * @param sessionId - the session whose host workspace resolves the path.
 * @param path - absolute or workspace-relative path.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
function sessionFileAddress(sessionId, path) {
    const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}
/**
 * Open one workspace file in a native sidebar tab (the shipped preview).
 * @param controller - `ctx.get('sidebarRight')`, probed at call time.
 * @param sessionId - the session the panel is drawn in.
 * @param path - workspace-relative path.
 * @param line - optional 1-based line to reveal in the preview.
 */
function openFileInTab(controller, sessionId, path, line) {
    const address = sessionFileAddress(sessionId, path);
    if (controller === undefined || typeof controller.openResource !== 'function') {
        return { ok: false, address, reason: '当前 DSH 没有提供侧栏控制器，已改用行内预览' };
    }
    try {
        controller.openResource(address, line === undefined || line < 1 ? { revealIfOpened: true } : { revealIfOpened: true, params: { line } });
        return { ok: true, address };
    }
    catch (error) {
        return { ok: false, address, reason: String(error?.message ?? error) };
    }
}
/**
 * A grammar hint for the official `CodeBlock`, from the file extension.
 * @param path - workspace-relative or absolute file path.
 * @returns a shiki language id, or undefined for plain text.
 */
function languageForPath(path) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    const byExtension = {
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
        txt: undefined,
    };
    if (name === 'dockerfile')
        return 'docker';
    if (name === 'makefile')
        return 'make';
    const language = byExtension[ext];
    return language === undefined || language === '' ? undefined : language;
}

return module.exports;
};
		return __require(1);
	},
});
