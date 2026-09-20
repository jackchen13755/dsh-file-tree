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
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { call, FilePanelError, type ContextValue, type EntryInfo, type Preview } from './api.js'
import { insertReference } from './reference.js'
import { languageForPath } from './tab.js'
import { runJump } from './jump-run.js'
import { toast } from './toast.js'
import {
  findDeclarationLine,
  importedFrom,
  lineElements,
  lineIndexOf,
  memberReceiver,
  quotedSpecifierAt,
  revealLine,
  specifierLike,
  trackJumpAffordance,
  wordAtPoint,
} from './jump.js'

/**
 * Build stamp shown in the panel header. Bump it whenever behaviour changes: a
 * page still running an older bundle shows an older stamp, which turns "it does
 * not work" into a one-glance answer instead of a guessing game.
 */
const BUILD_STAMP = 'b9'

/** Props the tab body receives from this plugin's `inject` factory. */
export interface FilePanelProps {
  readonly sessionId: string
  /** Open a workspace file in a native tab (the shipped preview); see `tab.ts`. */
  readonly openResource: (path: string, line?: number) => { ok: boolean; reason?: string }
}

type PrimitiveComponent = (props: Record<string, unknown>) => ReactNode

interface Primitives {
  readonly CodeBlock?: PrimitiveComponent
  readonly FileTypeIcon?: PrimitiveComponent
  readonly fileSizeText?: (bytes: number) => string
}

let cachedPrimitives: Primitives | null | undefined

/** The product's UI primitives, loaded once on first use. */
function primitives(): Primitives {
  if (cachedPrimitives === undefined) {
    try {
      cachedPrimitives = require('@deepseek-ai/dsh-client-ui-primitives') as Primitives
    } catch {
      cachedPrimitives = null
    }
  }
  return cachedPrimitives ?? {}
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
} as const

/** One indent step, shared by the rails and the row padding. */
const INDENT = 12
const ROW_HEIGHT = 21

/** Text of one rendered line, used by the specifier fallback. */
function containerLineText(container: HTMLElement, line: number): string | undefined {
  return lineElements(container)[line - 1]?.textContent ?? undefined
}

const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12, lineHeight: 1.45, color: TOKEN.text },
  header: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${TOKEN.border}` },
  title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  spacer: { flex: 1 },
  button: { border: `1px solid ${TOKEN.border}`, background: 'transparent', color: TOKEN.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
  iconButton: { border: 'none', background: 'transparent', color: TOKEN.dim, cursor: 'pointer', fontSize: 12, padding: '0 4px' },
  filterRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: `1px solid ${TOKEN.border}` },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
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
    whiteSpace: 'nowrap' as const,
    borderRadius: 3,
  },
  railCell: { width: INDENT, alignSelf: 'stretch' as const, borderLeft: `1px solid ${TOKEN.rail}` },
  chevron: { width: 14, textAlign: 'center' as const, color: TOKEN.dim, fontSize: 10, flex: 'none' as const },
  iconCell: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, flex: 'none' as const },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' },
  dirName: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', fontWeight: 500 },
  parent: { color: TOKEN.faint, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 6, flex: '0 1 auto' },
  size: { color: TOKEN.faint, fontSize: 11, marginLeft: 6, flex: 'none' as const, fontVariantNumeric: 'tabular-nums' as const },
  actions: { display: 'flex', alignItems: 'center', gap: 2, marginLeft: 4, flex: 'none' as const },
  previewBox: { borderTop: `1px solid ${TOKEN.border}`, display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '52%' },
  previewHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: `1px solid ${TOKEN.border}` },
  pre: {
    margin: 0,
    padding: '6px 8px',
    fontFamily: TOKEN.mono,
    fontSize: 11,
    whiteSpace: 'pre' as const,
    overflow: 'auto',
    flex: 1,
    minHeight: 0,
    background: 'rgba(0,0,0,.18)',
  },
  notice: { padding: '6px 10px', borderTop: `1px solid ${TOKEN.border}`, whiteSpace: 'pre-wrap' as const },
  empty: { padding: 14, color: TOKEN.dim, textAlign: 'center' as const },
} as const

/** Official size copy when the product provides it, a local one otherwise. */
function formatSize(bytes: number): string {
  const official = primitives().fileSizeText
  if (typeof official === 'function') {
    try {
      return official(bytes)
    } catch {
      // fall through to the local formatter
    }
  }
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Extensions the panel previews as a picture (the official preview is text-only). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])

/**
 * Whether a file should be previewed as a picture rather than opened in the
 * official tab. The product's preview is a TEXT preview: it renders an image as
 * "binary file" and an SVG as XML source, so pictures are shown here instead.
 * @param path - workspace-relative path.
 */
function isImagePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return IMAGE_EXTENSIONS.has(ext)
}

/**
 * Per-session UI memory: which directories were expanded. The search text is
 * deliberately NOT remembered — a panel that opens showing stale search results
 * is more confusing than helpful.
 */
interface StoredViewState {
  readonly expanded: readonly string[]
}

function storageKey(sessionId: string): string {
  return `dsh-file-tree:${sessionId}`
}

function readStored(sessionId: string): StoredViewState {
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionId))
    if (raw === null) return { expanded: [] }
    const parsed = JSON.parse(raw) as Partial<StoredViewState>
    return {
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.filter(item => typeof item === 'string') : [],
    }
  } catch {
    return { expanded: [] }
  }
}

function writeStored(sessionId: string, state: StoredViewState): void {
  try {
    window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(state))
  } catch {
    // A full or disabled sessionStorage must not break the panel.
  }
}

/** Last path segment, for showing a hit's parent directory in search results. */
function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** Fallback glyphs, used only when the product's icons are unavailable. */
function glyphFor(entry: EntryInfo, expandedDir: boolean): string {
  if (entry.dir) return expandedDir ? '▾' : '▸'
  const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return '▣'
  if (['md', 'markdown'].includes(ext)) return 'M'
  if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(ext)) return 'J'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'py', 'go', 'rs', 'java', 'sh'].includes(ext)) return '{}'
  return '·'
}

/**
 * The product's coloured icon for an entry, or the local glyph as a fallback.
 * @param entry - the row's entry.
 * @param expandedDir - whether a directory row is expanded.
 */
function entryIcon(entry: EntryInfo, expandedDir: boolean): ReactNode {
  const Icon = primitives().FileTypeIcon
  if (Icon !== undefined && !entry.dir) {
    return createElement(Icon, { path: entry.path, size: 14 })
  }
  if (Icon !== undefined) {
    // Only the product's declared kinds are valid here; the open/closed state is
    // the chevron's job, so both states use the folder glyph.
    return createElement(Icon, { kind: 'folder', size: 14 })
  }
  return createElement('span', { style: { ...S.chevron, color: TOKEN.dim } }, glyphFor(entry, expandedDir))
}

/**
 * Text preview. The product's own CodeBlock does the rendering when it is
 * available (shiki colouring, numbered gutter, copy button); otherwise a plain
 * numbered `<pre>` keeps the panel usable.
 * @param content - file text.
 * @param path - the file's path, used for the language hint.
 */
function textPreview(content: string, path: string): ReactNode {
  const lines = content.split('\n')
  const shown = lines.slice(0, 3000).join('\n')
  const CodeBlock = primitives().CodeBlock
  if (CodeBlock !== undefined) {
    return createElement(
      'div',
      { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
      createElement(CodeBlock, {
        code: shown,
        lang: languageForPath(path),
        lineNumbers: true,
        showHeader: false,
        copyLabel: '复制',
        copiedLabel: '已复制',
      }),
    )
  }
  const width = String(lines.length).length
  return createElement(
    'pre',
    { style: S.pre },
    lines.slice(0, 3000).map((line, index) => `${String(index + 1).padStart(width, ' ')}  ${line}`).join('\n'),
  )
}

/**
 * The file panel tab body.
 * @param props - the injected session id and the tab opener.
 */
export function FilePanel(props: FilePanelProps): ReactNode {
  const { sessionId, openResource } = props
  const [context, setContext] = useState<ContextValue | null>(null)
  /** Loaded directories keyed by workspace-relative path (`''` is the root); a key present means "expanded". */
  const [loaded, setLoaded] = useState<Record<string, readonly EntryInfo[]>>({})
  const [expanding, setExpanding] = useState<readonly string[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [filter, setFilter] = useState('')
  const [hits, setHits] = useState<readonly EntryInfo[] | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [hovered, setHovered] = useState('')
  const previewBody = useRef<HTMLElement | null>(null)
  const busyRef = useRef(false)

  const report = useCallback((error: unknown): void => {
    setNotice({
      kind: 'error',
      text: error instanceof FilePanelError ? error.message : String((error as Error)?.message ?? error),
    })
  }, [])

  const listDirectory = useCallback(
    async (path: string): Promise<void> => {
      const listing = await call<{ path: string; entries: EntryInfo[]; truncated: boolean }>('list', sessionId, { path })
      setLoaded(previous => ({ ...previous, [path]: listing.entries }))
      if (listing.truncated) setNotice({ kind: 'info', text: `${path === '' ? '工作区' : path} 条目过多，已截断显示` })
    },
    [sessionId],
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy('读取中…')
    try {
      const info = await call<ContextValue>('context', sessionId)
      setContext(info)
      const openPaths = Object.keys(loaded)
      // First load of this session: restore the directories the user had open.
      const restored = openPaths.length === 0 ? readStored(sessionId).expanded : openPaths
      for (const path of restored.length === 0 ? [''] : ['', ...restored.filter(item => item !== '')]) {
        await listDirectory(path)
      }
    } catch (error) {
      report(error)
    } finally {
      busyRef.current = false
      setBusy('')
    }
  }, [listDirectory, loaded, report, sessionId])

  useEffect(() => {
    void refresh()
    // Initial load only: later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const toggleDirectory = useCallback(
    async (entry: EntryInfo): Promise<void> => {
      if (loaded[entry.path] !== undefined) {
        setLoaded(previous => {
          const next: Record<string, readonly EntryInfo[]> = {}
          for (const [key, value] of Object.entries(previous)) {
            // Drop the directory and everything nested under it.
            if (key === entry.path || key.startsWith(`${entry.path}/`)) continue
            next[key] = value
          }
          return next
        })
        return
      }
      setExpanding(previous => [...previous, entry.path])
      try {
        await listDirectory(entry.path)
      } catch (error) {
        report(error)
      } finally {
        setExpanding(previous => previous.filter(path => path !== entry.path))
      }
    },
    [listDirectory, loaded, report],
  )

  const openFile = useCallback(
    async (entry: EntryInfo): Promise<void> => {
      try {
        setPreview(await call<Preview>('read', sessionId, { path: entry.path }))
        setNotice(null)
      } catch (error) {
        report(error)
      }
    },
    [report, sessionId],
  )

  /** Row click: hand the file to the product's preview tab. Falls back to the inline view. */
  const openInTab = useCallback(
    (entry: Pick<EntryInfo, 'path' | 'name'>): void => {
      const result = openResource(entry.path)
      if (result.ok) {
        setNotice({ kind: 'info', text: `已在标签页打开 ${entry.name}（官方预览）` })
        return
      }
      setNotice({ kind: 'error', text: result.reason ?? '打开失败' })
    },
    [openResource],
  )

  /**
   * Ctrl/Cmd-click inside the inline preview. Delegates the decision to the same
   * `runJump` the product's preview tab uses, so barrels, aliases and messages
   * behave identically in both places. A plain click on something jumpable says
   * what to do instead of doing nothing.
   */
  const jumpFromPreview = useCallback(
    (event: {
      ctrlKey: boolean
      metaKey: boolean
      target: unknown
      clientX?: number
      clientY?: number
      preventDefault?: () => void
    }): void => {
      const body = previewBody.current
      const current = preview
      if (body === null || current === null) return
      // Prefer the word actually under the cursor; fall back to the element's
      // text when the browser cannot resolve a caret (e.g. a synthetic event).
      const pointed =
        event.clientX === undefined || event.clientY === undefined ? undefined : wordAtPoint(event.clientX, event.clientY)
      const elementText = ((event.target as HTMLElement | null)?.textContent ?? '').trim()
      const token = (pointed ?? (elementText.length <= 80 ? elementText : '')).trim()
      if (token === '') return
      const line = lineIndexOf(body, event.target as Element | null)
      const lineText = line === undefined ? '' : (containerLineText(body, line) ?? '')
      if (!event.ctrlKey && !event.metaKey) {
        const jumpable =
          specifierLike(token) !== undefined ||
          quotedSpecifierAt(lineText, token) !== undefined ||
          /^[A-Za-z_$][\w$]*$/.test(token)
        if (jumpable) {
          const hint = '按住 Ctrl（macOS 为 Cmd）点击可跳转到定义或 import 的文件'
          setNotice({ kind: 'info', text: hint })
          toast(hint, 'info')
        }
        return
      }
      event.preventDefault?.()
      const readLines = async (path: string): Promise<readonly string[]> =>
        call<Preview>('read', sessionId, { path })
          .then(value => (value.content ?? '').split('\n'))
          .catch(() => [] as string[])
      void runJump({
        sessionId,
        path: current.path,
        lines: (current.content ?? '').split('\n'),
        token,
        lineText,
        line,
        resolveFrom: (from: string, specifier: string) =>
          call<{ path: string | null; reason?: string; rule?: string }>('resolve', sessionId, { path: from, specifier }),
        readLines: readLines as (path: string) => Promise<readonly string[]>,
        openResource,
        openInline: (path: string) => void openFile({ path, name: path, dir: false, size: 0, mtime: 0 }),
        revealLine: (lineNumber: number) => revealLine(body, lineNumber),
        isImage: isImagePath,
        notify: (kind: 'info' | 'error', text: string) => setNotice({ kind, text }),
      }).catch(report)
    },
    [openFile, openResource, preview, report, sessionId],
  )

  const reference = useCallback((path: string): void => {
    const result = insertReference(path)
    setNotice(
      result.ok
        ? { kind: 'info', text: `已插入 ${result.text} 到输入框` }
        : { kind: 'error', text: `插入失败：${result.reason ?? '未知原因'}` },
    )
  }, [])

  const copyPath = useCallback(
    (path: string): void => {
      const absolute = context === null || path === '' ? path : `${context.workspace}/${path}`
      void navigator.clipboard?.writeText(absolute)
      setNotice({ kind: 'info', text: `已复制 ${absolute}` })
    },
    [context],
  )

  // Search watches the filter with a small debounce: typing must not fire a walk
  // per keystroke.
  useEffect(() => {
    const query = filter.trim()
    if (query === '') {
      setHits(null)
      return undefined
    }
    const timer = setTimeout(() => {
      void call<{ query: string; hits: EntryInfo[] }>('search', sessionId, { query })
        .then(value => setHits(value.hits))
        .catch(report)
    }, 250)
    return () => clearTimeout(timer)
  }, [filter, report, sessionId])

  // Remember the view for this session: the tab body unmounts when another tab
  // is active, and losing the expansion on every switch is disorienting.
  useEffect(() => {
    writeStored(sessionId, { expanded: Object.keys(loaded).filter(path => path !== '') })
  }, [loaded, sessionId])

  const rows = useMemo(() => {
    const out: Array<{ entry: EntryInfo; depth: number }> = []
    const walk = (dirPath: string, depth: number): void => {
      for (const entry of loaded[dirPath] ?? []) {
        out.push({ entry, depth })
        if (entry.dir && loaded[entry.path] !== undefined) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [loaded])

  /** One action chip; only rendered while its row is hovered or selected. */
  const rowAction = (
    label: string,
    title: string,
    run: () => void,
    color?: string,
  ): ReactNode =>
    createElement(
      'button',
      {
        style: color === undefined ? S.iconButton : { ...S.iconButton, color },
        title,
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation()
          run()
        },
      },
      label,
    )

  const renderRow = (entry: EntryInfo, depth: number, showParent: boolean): ReactNode => {
    const expandedDir = entry.dir && loaded[entry.path] !== undefined
    const isSearching = entry.dir && expanding.includes(entry.path)
    const selected = preview !== null && preview.path === entry.path
    const active = hovered === entry.path || selected
    return createElement(
      'div',
      {
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
            void toggleDirectory(entry)
            return
          }
          if (isImagePath(entry.path)) {
            // The official preview cannot show a picture; render it here.
            setNotice({ kind: 'info', text: `图片用行内预览显示（官方预览是文本预览）` })
            void openFile(entry)
            return
          }
          openInTab(entry)
        },
      },
      // Indent rails: one per depth level, drawn as a faint vertical line.
      ...Array.from({ length: depth }, (_, index) => createElement('span', { key: `rail-${index}`, style: S.railCell })),
      createElement('span', { style: S.chevron }, entry.dir ? (expandedDir ? '▾' : '▸') : ''),
      createElement('span', { style: S.iconCell }, entryIcon(entry, expandedDir)),
      createElement('span', { style: entry.dir ? S.dirName : S.name }, entry.name),
      showParent && parentOf(entry.path) !== '' ? createElement('span', { style: S.parent }, parentOf(entry.path)) : null,
      isSearching ? createElement('span', { style: { ...S.parent, color: TOKEN.dim } }, '…') : null,
      createElement('span', { style: S.spacer }),
      entry.dir ? null : createElement('span', { style: S.size }, formatSize(entry.size)),
      active
        ? createElement(
          'span',
          { style: S.actions },
          entry.dir
            ? null
            : rowAction('▤', '在本面板内预览', () => void openFile(entry)),
          entry.dir ? null : rowAction('＠', `把 @${entry.path} 插入输入框`, () => reference(entry.path)),
          rowAction('⧉', '复制绝对路径', () => copyPath(entry.path)),
        )
        : null,
    )
  }

  useEffect(() => {
    const body = previewBody.current
    if (body === null) return undefined
    return trackJumpAffordance(body)
  }, [preview])

  const workspaceName = context === null ? '…' : (context.workspace.split('/').filter(Boolean).pop() ?? context.workspace)

  const previewPane =
    preview === null
      ? null
      : createElement(
        'div',
        { style: S.previewBox },
        createElement(
          'div',
          { style: S.previewHead },
          createElement('span', { style: S.iconCell }, entryIcon({ path: preview.path, name: preview.path, dir: false, size: preview.size, mtime: 0 }, false)),
          createElement('span', { style: { ...S.title, flex: 1 }, title: preview.path }, preview.path),
          preview.kind === 'text'
            ? createElement('span', { style: { ...S.parent, whiteSpace: 'nowrap' } }, 'Ctrl/Cmd+点击跳转')
            : null,
          createElement('span', { style: S.size }, formatSize(preview.size)),
          preview.kind === 'text' && preview.truncated === true
            ? createElement('span', { style: { ...S.size, color: TOKEN.danger } }, '已截断')
            : null,
          createElement(
            'button',
            {
              style: S.button,
              title: isImagePath(preview.path) ? '用文本方式查看源码（官方文本预览）' : '在标签页用官方预览打开',
              onClick: () => openInTab({ path: preview.path, name: preview.path }),
            },
            isImagePath(preview.path) ? '↗ 源码' : '↗ 标签打开',
          ),
          createElement('button', { style: S.button, title: '把该文件引用插入输入框', onClick: () => reference(preview.path) }, '＠ 引用'),
          createElement('button', { style: S.iconButton, title: '复制绝对路径', onClick: () => copyPath(preview.path) }, '⧉'),
          createElement('button', { style: S.iconButton, title: '关闭预览', onClick: () => setPreview(null) }, '✕'),
        ),
        preview.kind === 'text'
          ? createElement(
            'div',
            {
              ref: (element: unknown) => { previewBody.current = (element ?? null) as HTMLElement | null },
              'data-dsh-file-tree-preview': '',
              style: { flex: 1, minHeight: 0, overflow: 'auto' },
              onClick: jumpFromPreview,
              title: 'Ctrl/Cmd + 点击：跳到定义或打开 import 的文件',
            },
            textPreview(preview.content ?? '', preview.path),
          )
          : preview.kind === 'image'
            ? createElement(
              'div',
              { style: { ...S.body, padding: 8, textAlign: 'center' } },
              createElement('img', { src: preview.content, alt: preview.path, style: { maxWidth: '100%', maxHeight: '100%' } }),
            )
            : createElement(
              'div',
              { style: S.empty },
              preview.kind === 'binary'
                ? '二进制文件，无法以文本预览。'
                : `文件过大（${formatSize(preview.size)}），超过预览上限。`,
            ),
      )

  return createElement(
    'div',
    { style: S.root },
    createElement(
      'div',
      { style: S.header },
      createElement('span', { style: S.iconCell }, entryIcon({ path: '', name: workspaceName, dir: true, size: 0, mtime: 0 }, false)),
      createElement('span', { style: S.title, title: context?.workspace ?? '' }, workspaceName),
      // Build stamp: a page that still runs an older bundle shows an older stamp,
      // which turns "it does not work" into a one-glance answer.
      createElement('span', { style: { ...S.parent, whiteSpace: 'nowrap' }, title: `dsh-file-tree ${BUILD_STAMP}` }, BUILD_STAMP),
      busy === '' ? null : createElement('span', { style: { ...S.size, color: TOKEN.dim } }, busy),
      createElement('span', { style: S.spacer }),
      createElement('button', { style: S.iconButton, title: '刷新（重新读取已展开的目录）', onClick: () => void refresh() }, '↻'),
    ),
    createElement(
      'div',
      { style: S.filterRow },
      createElement('input', {
        value: filter,
        placeholder: '搜索文件名…（Esc 清空）',
        'aria-label': '搜索文件名',
        style: S.input,
        onChange: (event: { target: { value: string } }) => setFilter(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Escape') setFilter('')
        },
      }),
      filter.trim() === '' ? null : createElement('span', { style: { ...S.size, whiteSpace: 'nowrap' } }, `${hits?.length ?? 0} 命中`),
    ),
    createElement(
      'div',
      { style: S.body, onMouseLeave: () => setHovered('') },
      filter.trim() !== ''
        ? hits === null
          ? createElement('div', { style: S.empty }, '搜索中…')
          : hits.length === 0
            ? createElement('div', { style: S.empty }, `没有匹配「${filter.trim()}」的文件。`)
            : hits.map(entry => renderRow(entry, 0, true))
        : rows.length === 0
          ? createElement('div', { style: S.empty }, context === null ? '正在读取工作区…' : '这个工作区是空的。')
          : rows.map(row => renderRow(row.entry, row.depth, false)),
    ),
    previewPane,
    notice === null
      ? null
      : createElement('div', { style: { ...S.notice, color: notice.kind === 'error' ? TOKEN.danger : TOKEN.ok } }, notice.text),
  )
}
