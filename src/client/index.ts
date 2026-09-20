/**
 * dsh-file-tree — browser half.
 *
 * Two entries, registered through two different seams on purpose:
 *
 * - **文件面板** (the read-only tree, preview and `@`-reference) is a native tab
 *   type via `ctx.sidebarRightTabs`, with its body in the keyed
 *   `sidebar.right.pane.tab` slot. It keeps its body but no longer offers a
 *   guide box: the editor below is its replacement as the way in.
 * - **编辑器** (the embedded code-server workbench) is registered through
 *   **dsh-better-sidebar** (`ctx.betterSidebar.registerTab`), which is where the
 *   tab family lives — its built-ins already contribute 文件变动 / 任务管理 /
 *   源代码管理 / 终端 to the new-tab list, and registering there puts the editor
 *   beside them under the same lifecycle, settings toggles and HMR-safe
 *   disposer instead of in a list of its own.
 *
 * Nothing here appends columns or writes the shell's grid: both entries ride
 * the sidebar's own tab system (see the sibling dsh-source-control plugin for
 * why that matters on DSH 0.1.6).
 */
import type { ReactNode } from 'react'
import { call, type Preview } from './api.js'
import { lineElements, lineIndexOf, wordAtPoint } from './jump.js'
import { runJump } from './jump-run.js'
import { EditorTab } from './editor-tab.js'
import { FilePanel } from './panel.js'
import { openFileInTab, type OpenResult, type SidebarRightLike } from './tab.js'
import { toast } from './toast.js'

/** Registration identity shared by the tab registry and the body slot. */
const TYPE_ID = 'dsh-file-tree:files'
/**
 * The native kind this plugin's panel claims.
 *
 * Deliberately NOT `files`: dsh-better-sidebar already registers that kind for
 * its own file tree (titled "工作区文件"), and a second registration of the same
 * kind throws — which silently took the rest of the registration pass with it.
 */
const KIND = 'dsh-file-tree:panel'
/** The two better-sidebar tab ids; each doubles as the native tab kind. */
const FILES_TAB_ID = 'dsh-file-tree:files'
const EDITOR_TAB_ID = 'dsh-file-tree:editor'

/**
 * dsh-better-sidebar's registration face, declared structurally.
 *
 * Structural on purpose: the plugin is optional at build time (a profile may run
 * without it), and reading the service through `ctx.get` keeps that plugin's
 * types out of this package's dependency graph while still failing safe — with
 * no service, the native entries below are all that register.
 */
interface BetterSidebarService {
  registerTab(descriptor: {
    readonly id: string
    readonly title: string | (() => string)
    readonly description?: string | (() => string)
    readonly icon?: unknown
    readonly order?: number
    readonly single?: boolean
    readonly component: (props: { readonly scope?: { readonly sessionId?: string } }) => ReactNode
  }): () => void
}

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

/**
 * Read dsh-better-sidebar's registration service.
 *
 * Read through `ctx.get` rather than the typed property: the plugin is an
 * optional companion, and reading an uninjected service as a property throws
 * ("cannot get property without inject") on the compositions that lack it.
 * @param holder - a context or an injected-scope reader.
 */
function betterSidebarOf(holder: { get(name: string): unknown }): BetterSidebarService | undefined {
  try {
    const service = holder.get('betterSidebar') as Partial<BetterSidebarService> | undefined
    return typeof service?.registerTab === 'function' ? (service as BetterSidebarService) : undefined
  } catch {
    return undefined
  }
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
  // Wrapped in an effect so a reload disposes the registration before re-adding
  // it: an undisposed `tabs.register` throws `tab kind "files" is already
  // registered` on the next mount and takes the rest of that pass with it.
  ctx.effect(() => ctx.inject(['sidebarRightTabs'], injected => {
    const tabs = injected.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return undefined
    const disposers = [
      // This native type is the panel's *address claim*: file rows and jumps
      // hand `dsh-resource://file/…` to the sidebar, and the panel claims those
      // addresses. It carries no `guide`, so the two entries the new-tab list
      // offers (文件面板 / 编辑器) both come from better-sidebar below instead.
      tabs.register({
        id: TYPE_ID,
        kind: KIND,
        title: () => '文件面板',
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }), 'dsh-file-tree: native tab types')

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

  // The editor is a better-sidebar tab, which is where the tab family lives.
  // Its descriptor takes the component directly: there is no separate slot to
  // key, and the service's disposer makes this safe across reloads.
  //
  // Waiting through `ctx.inject` rather than reading `ctx.get` once: the service
  // belongs to a sibling plugin, and a one-shot read at apply time finds nothing
  // (measured) — the injected callback runs when the service is actually there.
  ctx.inject(['betterSidebar'], injected => {
    const service = betterSidebarOf(injected)
    if (service === undefined) return undefined
    const disposers = [
      service.registerTab({
        id: FILES_TAB_ID,
        title: () => '文件面板',
        description: () => '工作区文件树 + 预览 + @文件引用',
        order: 20,
        single: true,
        component: props => {
          const sessionId = String(props.scope?.sessionId ?? lastSessionId ?? '')
          lastSessionId = sessionId
          return FilePanel({
            sessionId,
            // Jumping lands in the product's own preview tab, which is a
            // separate surface from these tabs.
            openResource: (path: string, line?: number) => {
              const result = openFileInTab(ctx.get('sidebarRight') as SidebarRightLike | undefined, sessionId, path, line)
              if (result.ok) lastOpenedInTab = { sessionId, path }
              return result
            },
          })
        },
      }),
      service.registerTab({
        id: EDITOR_TAB_ID,
        title: () => '编辑器',
        description: () => 'code-server（VS Code 网页版），直接编辑工作区文件',
        order: 21,
        // One editor per session: reopening focuses the existing tab.
        single: true,
        component: props => EditorTab({ sessionId: String(props.scope?.sessionId ?? lastSessionId ?? '') }),
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

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
            resolveFrom: (from, specifier) =>
              call<{ path: string | null; reason?: string; rule?: string }>('resolve', sessionId, { path: from, specifier }),
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
