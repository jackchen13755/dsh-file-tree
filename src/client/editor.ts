/**
 * The embedded code-server editor view.
 *
 * The iframe points at this plugin's own origin (`/dsh-file-tree/code-server/…`),
 * which the host reverse-proxies to a per-workspace code-server process. That
 * matters: a separate origin would be blocked by code-server's own
 * `Cross-Origin-Resource-Policy` on framed subresources, so the page has to be
 * same-origin with the panel — and that is also why nothing here talks to a
 * second port.
 *
 * code-server 4.138 exposes no way to ask the workbench to open a file (no
 * `?payload=`, no `postMessage` command; measured, not assumed), so this view
 * does not pretend otherwise: it opens the workbench on the session's workspace
 * and the workbench's own Explorer does the file opening.
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { call, FilePanelError, type EditorStatus } from './api.js'

/** Palette shared with the panel. */
const TOKEN = {
  text: 'var(--dsw-alias-text-1, #e6e6e6)',
  dim: 'var(--dsw-alias-text-3, #9a9a9a)',
  border: 'var(--dsw-alias-border-l2, #333)',
  danger: 'var(--dsw-alias-danger-1, #f85149)',
  ok: 'var(--dsw-alias-success-1, #3fb950)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const

const S = {
  // Sized for BOTH seat shapes on purpose. better-sidebar wraps a tab in a
  // column flex host, while DSH's native tab body is a plain block scroll
  // container: `flex: 1` does nothing in the latter, so the `height`/`maxHeight`
  // pair is what keeps this tab from collapsing (or from overflowing the panel).
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    maxHeight: '100%',
    minHeight: 0,
    overflow: 'hidden',
    borderTop: `1px solid ${TOKEN.border}`,
  },
  bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: `1px solid ${TOKEN.border}` },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontWeight: 600 },
  spacer: { flex: 1 },
  button: {
    border: `1px solid ${TOKEN.border}`,
    background: 'transparent',
    color: TOKEN.text,
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 12,
    cursor: 'pointer',
  },
  iconButton: { border: 'none', background: 'transparent', color: TOKEN.dim, cursor: 'pointer', fontSize: 12, padding: '0 4px' },
  frame: { border: 0, width: '100%', flex: '1 1 auto', height: '100%', minHeight: 0, background: '#1e1e1e' },
  center: { display: 'flex', flexDirection: 'column', gap: 6, padding: 14, color: TOKEN.dim, alignItems: 'flex-start' },
  error: { color: TOKEN.danger },
  hint: { color: TOKEN.dim, fontSize: 11, padding: '0 8px 4px' },
  code: {
    fontFamily: TOKEN.mono,
    fontSize: 11,
    background: 'rgba(0,0,0,.25)',
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 4,
    padding: '6px 8px',
    whiteSpace: 'pre-wrap' as const,
    margin: 0,
    maxWidth: '100%',
  },
} as const

/** Props the editor view takes. */
export interface EditorViewProps {
  readonly sessionId: string
  /** Status to display before the first request completes. */
  readonly initial: EditorStatus | null
  readonly onStatus: (status: EditorStatus) => void
  /** Omitted when the view *is* the tab: a tab closes from the tab strip, not from a bar button. */
  readonly onClose?: () => void
}

/**
 * The editor view: a status bar over the workbench iframe.
 * @param props - session identity, status plumbing and the close action.
 */
export function EditorView(props: EditorViewProps): ReactNode {
  const { sessionId, initial, onStatus, onClose } = props
  const [status, setStatus] = useState<EditorStatus | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const instance = status?.enabled === true ? status.instance : undefined
  const ready = instance?.state === 'ready' && instance.url !== ''

  /** Ask the host for the editor, optionally without starting one. */
  const load = useCallback(
    async (start: boolean): Promise<void> => {
      try {
        const value = await call<EditorStatus>('editor', sessionId, start ? {} : { start: false })
        setStatus(value)
        onStatus(value)
        setError(null)
      } catch (failure) {
        setError(failure instanceof FilePanelError ? failure.message : String((failure as Error)?.message ?? failure))
      }
    },
    [onStatus, sessionId],
  )

  // The view mounts when its tab is shown, so the first request legitimately
  // starts a process.
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      setBusy(true)
      await load(true)
      if (!cancelled) setBusy(false)
    }
    void tick()
    return () => {
      cancelled = true
    }
    // Mount-only: later refreshes are explicit or polled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // While a workbench boots, poll the cheap status read so the view follows the
  // host's own state instead of guessing at a fixed delay.
  useEffect(() => {
    if (instance === undefined || instance.state !== 'starting') return undefined
    const timer = setInterval(() => void load(false), 1500)
    return () => clearInterval(timer)
  }, [instance, load])

  const reload = useCallback((): void => {
    setBusy(true)
    void load(true).finally(() => setBusy(false))
  }, [load])

  const body = ((): ReactNode => {
    if (error !== null) {
      return createElement(
        'div',
        { style: S.center },
        createElement('span', { style: S.error }, `编辑器不可用：${error}`),
        createElement('span', null, '可以用下面的操作重试。'),
      )
    }
    if (status === null) return createElement('div', { style: S.center }, '正在准备编辑器…')
    if (status.enabled === false) {
      return createElement(
        'div',
        { style: S.center },
        createElement('span', null, '嵌入式编辑器已在插件配置里关闭（codeServerEnabled: false）。'),
        createElement(
          'pre',
          { style: S.code },
          "在 profile 的 cordis.patch.yml 里为 file-tree 打开它：\n- id: file-tree\n  config:\n    codeServerEnabled: true",
        ),
      )
    }
    if (instance?.state === 'failed') {
      return createElement(
        'div',
        { style: S.center },
        createElement('span', { style: S.error }, '编辑器启动失败'),
        createElement('pre', { style: S.code }, instance.error ?? '（没有更多信息）'),
        createElement('span', { style: { ...S.hint, padding: 0 } }, '装好 code-server 后点「重试」。'),
      )
    }
    if (!ready) {
      return createElement(
        'div',
        { style: S.center },
        createElement('span', null, instance?.note ?? '正在启动 code-server…'),
        createElement('span', { style: { ...S.hint, padding: 0 } }, '首次启动需要几秒（要拉起扩展宿主）。'),
      )
    }
    return createElement('iframe', {
      ref: (element: unknown) => {
        frame.current = (element ?? null) as HTMLIFrameElement | null
      },
      src: `${instance.url}?folder=${encodeURIComponent(instance.workspace)}`,
      title: `code-server · ${instance.workspace}`,
      style: S.frame,
      // The workbench needs clipboard and fullscreen; nothing else is granted.
      allow: 'clipboard-read; clipboard-write; fullscreen',
      'data-dsh-file-tree-editor': '',
    })
  })()

  return createElement(
    'div',
    { style: S.root, 'data-dsh-file-tree-editor-root': '' },
    createElement(
      'div',
      { style: S.bar },
      createElement('span', { style: { ...S.title, flex: '0 1 auto' } }, '编辑器'),
      createElement(
        'span',
        { style: { ...S.hint, padding: 0, whiteSpace: 'nowrap' } },
        instance?.version === undefined ? 'code-server' : `code-server ${instance.version}`,
      ),
      ready ? createElement('span', { style: { ...S.hint, padding: 0, color: TOKEN.ok } }, '● 就绪') : null,
      createElement('span', { style: S.spacer }),
      busy ? createElement('span', { style: { ...S.hint, padding: 0 } }, '处理中…') : null,
      ready
        ? createElement(
          'button',
          { style: S.iconButton, title: '重新加载工作台（不重启进程）', onClick: () => frame.current?.contentWindow?.location.reload() },
          '↻',
        )
        : null,
      createElement('button', { style: S.button, title: '重新检查并启动 code-server', onClick: reload }, '重试'),
      onClose === undefined
        ? null
        : createElement('button', { style: S.iconButton, title: '关闭编辑器', onClick: onClose }, '✕'),
    ),
    body,
    ready && onClose !== undefined
      ? createElement('div', { style: S.hint }, '工作台左侧的资源管理器就是文件树；「文件面板」标签页保留工作区的只读浏览与 @引用。')
      : null,
  )
}
