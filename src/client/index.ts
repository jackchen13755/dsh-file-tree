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
            inject: (sessionId: string) => ({
              sessionId,
              // Probing the controller per open keeps this plugin working on a
              // profile whose sidebar is composed differently.
              openResource: (path: string, line?: number) => {
                const result = openFileInTab(ctx.get('sidebarRight') as SidebarRightLike | undefined, sessionId, path, line)
                if (result.ok) lastOpenedInTab = { sessionId, path }
                return result
              },
            }),
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
      const opened = lastOpenedInTab
      if (opened === undefined) return
      const { sessionId, path } = opened
      const token = wordAtPoint(event.clientX, event.clientY)
      if (token === undefined || token === '') return
      const container = panel as HTMLElement
      const line = lineIndexOf(container, target)
      const lineText = line === undefined ? '' : (lineElements(container)[line - 1]?.textContent ?? '')
      void call<Preview>('read', sessionId, { path })
        .then(preview => {
          // Guard against a stale record: the rendered preview must be showing
          // this file (compare the first non-empty line both ways).
          const rendered = lineElements(container)
            .map(element => (element.textContent ?? '').trim())
            .find(text => text !== '')
          const source = (preview.content ?? '')
            .split('\n')
            .map(text => text.trim())
            .find(text => text !== '')
          if (rendered === undefined || source === undefined || rendered !== source) {
            toast('这个标签页显示的不是最近打开的文件，请在「文件面板」里重新打开后再跳转', 'info')
            return
          }
          event.preventDefault()
          event.stopPropagation()
          return runJump({
            sessionId,
            path,
            lines: (preview.content ?? '').split('\n'),
            token,
            lineText,
            line,
            resolve: specifier => call<{ path: string | null; reason?: string }>('resolve', sessionId, { path, specifier }),
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
