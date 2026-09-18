/**
 * dsh-file-tree — browser half.
 *
 * Registers the "文件面板" tab type in the native right sidebar plus the keyed
 * slot body that draws it. Nothing here appends columns or writes the shell's
 * grid: the panel rides the sidebar's own tab system (see the sibling
 * dsh-source-control plugin for why that matters on DSH 0.1.6).
 */
import type { ReactNode } from 'react'
import { call, type Preview } from './api.js'
import { lineElements, lineIndexOf, wordAtPoint } from './jump.js'
import { runJump } from './jump-run.js'
import { FilePanel } from './panel.js'
import { openFileInTab, type OpenResult, type SidebarRightLike } from './tab.js'
import { toast } from './toast.js'

/** Registration identity shared by the tab registry and the body slot. */
const TYPE_ID = 'dsh-file-tree:files'
/** Tab kind that `openTab` names. */
const KIND = 'files'

/** The slot service's two calls this plugin makes (declared structurally). */
interface SlotsService {
  inject(name: string, callback: () => void | (() => void)): void
  register(options: unknown, component: unknown): () => void
}

/** The slice of the client context this plugin touches. */
interface ClientContext {
  readonly slots: SlotsService
  /** The right sidebar's controller, read lazily: it is provided by the product. */
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
  inject(
    names: readonly string[],
    callback: (injected: { get(name: string): unknown }) => void | (() => void),
  ): void
}

/** One guide entry, as the tab registry wants it. */
interface GuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description: () => string
}

/** The tab-type registry face (`ctx.sidebarRightTabs`). */
interface TabRegistry {
  register(definition: {
    readonly id: string
    readonly kind: string
    readonly multiple?: boolean
    readonly title: (address: string) => string
    readonly guide?: readonly GuideEntry[]
  }): () => void
}

/** `slots` is the only service needed before the first render. */
export const inject = ['slots']

/**
 * The last file this plugin opened in a native tab. The product's preview tab
 * exposes neither its address nor its path, so the tab-level jump listener needs
 * this record — and it verifies the record against the rendered text before
 * acting on it, so a stale entry (another session's tab) cannot misfire.
 */
let lastOpenedInTab: { sessionId: string; path: string } | undefined

/** The session this plugin's panel is mounted in — routes need it, and the
 * document-level listener may run while the panel body is unmounted. */
let lastSessionId: string | undefined

/** One entry of the product's open-tab inventory (`ctx.sidebarRight.openTabs`). */
interface OpenTabEntry {
  readonly sessionId: string
  readonly kind: string
  readonly contentId: string
}

/** The inventory is an observable snapshot of those entries. */
interface OpenTabsFace {
  getSnapshot?: () => readonly OpenTabEntry[]
}

/**
 * Decode a `dsh-resource://file/session/<sessionId>/<path>` address.
 * @param address - the tab's content address.
 */
function filePathFromAddress(address: string): { sessionId: string; path: string } | undefined {
  const prefix = 'dsh-resource://file/session/'
  if (!address.startsWith(prefix)) return undefined
  const rest = address.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  try {
    return {
      sessionId: decodeURIComponent(rest.slice(0, slash)),
      path: rest
        .slice(slash + 1)
        .split('/')
        .map(segment => decodeURIComponent(segment))
        .join('/'),
    }
  } catch {
    return undefined
  }
}

/**
 * Every file the sidebar currently has open, straight from the product's own
 * inventory — which is republished from the persisted layout, so it also covers
 * tabs restored by a page refresh that this plugin never opened itself.
 * @param ctx - client context.
 */
function openFileTabs(ctx: ClientContext): Array<{ sessionId: string; path: string }> {
  try {
    const controller = ctx.get('sidebarRight') as { openTabs?: OpenTabsFace | readonly OpenTabEntry[] } | undefined
    const source = controller?.openTabs
    const entries = Array.isArray(source) ? source : ((source as OpenTabsFace | undefined)?.getSnapshot?.() ?? [])
    const out: Array<{ sessionId: string; path: string }> = []
    for (const entry of entries) {
      const decoded = filePathFromAddress(String(entry.contentId ?? ''))
      if (decoded !== undefined) out.push(decoded)
    }
    return out
  } catch {
    return []
  }
}

/** The active right-sidebar tab's title (the product titles file tabs with the basename). */
function activeTabTitle(): string {
  const chips = [...document.querySelectorAll('[data-rightbar-col] [role=tab]')]
  const active = chips.find(chip => chip.getAttribute('aria-selected') === 'true') ?? chips[chips.length - 1]
  return (active?.textContent ?? '').trim()
}

/**
 * Which file is the product's preview tab showing, and in which session?
 *
 * Self-sufficient on purpose: the panel body is NOT mounted while the user is
 * looking at a file tab, so nothing here may depend on that plugin's own state.
 * The product's open-tab inventory carries `{ sessionId, contentId }` for every
 * tab — including the tabs a page refresh restored.
 *
 * Candidates are title-matched first, then confirmed by comparing the first
 * non-empty line of the rendered preview with the file's own.
 *
 * @param ctx - client context (for the inventory and the fallback search).
 * @param renderedLines - the preview's visible lines.
 * @returns the session and workspace-relative path, or undefined when nothing matches.
 */
async function resolvePreviewFile(
  ctx: ClientContext,
  renderedLines: readonly string[],
): Promise<{ sessionId: string; path: string } | undefined> {
  const firstRendered = renderedLines.map(text => text.trim()).find(text => text !== '')
  if (firstRendered === undefined) return undefined
  const firstLineOf = async (sessionId: string, path: string): Promise<string | undefined> => {
    const preview = await call<Preview>('read', sessionId, { path }).catch(() => undefined)
    return (preview?.content ?? '')
      .split('\n')
      .map(text => text.trim())
      .find(text => text !== '')
  }
  const title = activeTabTitle()
  const open = openFileTabs(ctx)
  const matchesTitle = (candidate: { path: string }): boolean =>
    title !== '' && (candidate.path.split('/').pop() ?? '') === title
  const ordered = [...open.filter(matchesTitle), ...open.filter(candidate => !matchesTitle(candidate))]
  for (const tab of ordered.slice(0, 5)) {
    if ((await firstLineOf(tab.sessionId, tab.path)) === firstRendered) return tab
  }
  const remembered = lastOpenedInTab
  if (remembered !== undefined && (await firstLineOf(remembered.sessionId, remembered.path)) === firstRendered) {
    return remembered
  }
  if (lastSessionId === undefined || title === '') return undefined
  const found = await call<{ hits: Array<{ path: string; dir: boolean }> }>('search', lastSessionId, {
    query: title,
  }).catch(() => undefined)
  for (const candidate of (found?.hits ?? []).filter(hit => !hit.dir).slice(0, 4)) {
    if ((await firstLineOf(lastSessionId, candidate.path)) === firstRendered) {
      return { sessionId: lastSessionId, path: candidate.path }
    }
  }
  return undefined
}

/**
 * Register the tab type, its body, and the guide entry that opens it.
 * @param ctx - client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['sidebarRightTabs'], injected => {
    const tabs = injected.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return undefined
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
    })
  })

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TYPE_ID,
            inject: (sessionId: string) => {
              lastSessionId = sessionId
              return {
                sessionId,
                // Probing the controller per open keeps this plugin working on a
                // profile whose sidebar is composed differently.
                openResource: (path: string, line?: number) => {
                  const result = openFileInTab(ctx.get('sidebarRight') as SidebarRightLike | undefined, sessionId, path, line)
                  if (result.ok) lastOpenedInTab = { sessionId, path }
                  return result
                },
              }
            },
          },
          (props: { sessionId: string; openResource: (path: string, line?: number) => OpenResult }): ReactNode => FilePanel(props),
        ),
      ),
    'dsh-file-tree: panel body',
  )

  // Jumps inside the PRODUCT's preview tab: the same decision logic, triggered
  // from a document-level capture listener because that DOM belongs to another
  // component. It only acts on Ctrl/Cmd-clicks inside the right sidebar and
  // outside this plugin's own preview (which reports through its notice line).
  ctx.effect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target === null) return
      const panel = target.closest('[data-sidebar-right-panel]')
      if (panel === null) return
      if (target.closest('[data-dsh-file-tree-preview]') !== null) return
      const token = wordAtPoint(event.clientX, event.clientY)
      if (token === undefined || token === '') return
      const container = panel as HTMLElement
      const line = lineIndexOf(container, target)
      const lineText = line === undefined ? '' : (lineElements(container)[line - 1]?.textContent ?? '')
      // The rendered text IS the file's text as far as a jump is concerned, so it
      // is used directly: no host read of the file on screen is needed.
      const renderedLines = lineElements(container).map(element => element.textContent ?? '')
      const firstRendered = renderedLines.map(text => text.trim()).find(text => text !== '')
      if (firstRendered === undefined) return
      void resolvePreviewFile(ctx, renderedLines)
        .then(resolved => {
          if (resolved === undefined) {
            toast('认不出这个标签页显示的是哪个文件，请在「文件面板」里点一次该文件后再 Ctrl+点击', 'info')
            return
          }
          const { sessionId, path } = resolved
          event.preventDefault()
          event.stopPropagation()
          return runJump({
            sessionId,
            path,
            lines: renderedLines,
            token,
            lineText,
            line,
            resolve: specifier => call<{ path: string | null; reason?: string; rule?: string }>('resolve', sessionId, { path, specifier }),
            readLines: async target2 =>
              call<Preview>('read', sessionId, { path: target2 })
                .then(value => (value.content ?? '').split('\n'))
                .catch(() => [] as string[]),
            openResource: (target2, atLine) => {
              const result = openFileInTab(
                ctx.get('sidebarRight') as SidebarRightLike | undefined,
                sessionId,
                target2,
                atLine,
              )
              if (result.ok) lastOpenedInTab = { sessionId, path: target2 }
              return result
            },
            openInline: () => toast('图片请在「文件面板」里查看（标签页预览不支持图片）', 'info'),
            revealLine: lineNumber => {
              const element = lineElements(container)[lineNumber - 1]
              if (element === undefined) return false
              element.scrollIntoView({ block: 'center' })
              const previous = element.style.backgroundColor
              element.style.backgroundColor = 'rgba(77,107,254,.28)'
              setTimeout(() => {
                element.style.backgroundColor = previous
              }, 900)
              return true
            },
            isImage: candidate => /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(candidate),
            notify: (kind, text) => toast(text, kind),
          })
        })
        .catch(error => toast(String((error as Error)?.message ?? error), 'error'))
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, 'dsh-file-tree: preview tab jumps')
}
