/**
 * The standalone 编辑器 tab body.
 *
 * This is the whole tab: a full-height code-server workbench and nothing else.
 * It exists as its own sidebar entry (rather than a view inside the file panel)
 * because a workbench needs the full column — a tree sharing the same 300-odd
 * pixels leaves an editor too short to read a file in.
 *
 * The file panel keeps its own tab for the read-only side of the workspace:
 * browsing, previewing and `@`-referencing files.
 */
import { createElement, useState, type ReactNode } from 'react'
import type { EditorStatus } from './api.js'
import { EditorView } from './editor.js'

/** Props the seat hands the tab body. */
export interface EditorTabProps {
  readonly sessionId: string
}

/**
 * The editor tab body.
 * @param props - the session id this tab is drawn in.
 */
export function EditorTab(props: EditorTabProps): ReactNode {
  const { sessionId } = props
  const [status, setStatus] = useState<EditorStatus | null>(null)
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    createElement(EditorView, {
      sessionId,
      initial: status,
      onStatus: setStatus,
    }),
  )
}
