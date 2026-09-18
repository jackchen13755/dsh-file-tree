/**
 * dsh-file-tree — browser half.
 *
 * Registers the "文件面板" tab type in the native right sidebar plus the keyed
 * slot body that draws it. Nothing here appends columns or writes the shell's
 * grid: the panel rides the sidebar's own tab system (see the sibling
 * dsh-source-control plugin for why that matters on DSH 0.1.6).
 */
import type { ReactNode } from 'react'
import { FilePanel } from './panel.js'
import { openFileInTab, type OpenResult, type SidebarRightLike } from './tab.js'

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
              openResource: (path: string, line?: number) =>
                openFileInTab(ctx.get('sidebarRight') as SidebarRightLike | undefined, sessionId, path, line),
            }),
          },
          (props: { sessionId: string; openResource: (path: string, line?: number) => OpenResult }): ReactNode => FilePanel(props),
        ),
      ),
    'dsh-file-tree: panel body',
  )
}
