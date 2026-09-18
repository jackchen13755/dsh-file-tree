/**
 * `@file` references: the product's grammar is plain text, so inserting one is
 * a text insertion into the composer — no private API involved.
 *
 * Format (shared with `@deepseek-ai/dsh-file-reference/grammar`):
 * `@path/to/file` normally, `@"path with spaces"` when the path needs quoting.
 * The host resolves the token against the session workspace when the message is
 * sent, which is why the panel inserts a workspace-RELATIVE path.
 */

/**
 * Format a workspace-relative path as the mention text the composer accepts.
 * @param relativePath - `/`-separated path relative to the workspace root.
 */
export function mentionText(relativePath: string): string {
  return /[\s"'`]/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`
}

/**
 * Find the conversation composer: the visible rich-text input that is NOT part
 * of the right sidebar (where this panel lives).
 * @returns the composer element, or undefined when the conversation is not mounted.
 */
export function findComposer(): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')]
    .filter(element => element.closest('[data-rightbar-col]') === null)
    .filter(element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
  // The composer sits at the bottom of the conversation: take the lowest one.
  return candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
}

/** What an insertion attempt did, for the panel's notice line. */
export interface InsertResult {
  readonly ok: boolean
  readonly text: string
  readonly reason?: string
}

/**
 * Insert one file reference into the composer, moving the caret to the end.
 * @param relativePath - workspace-relative path to reference.
 */
export function insertReference(relativePath: string): InsertResult {
  const text = mentionText(relativePath)
  const composer = findComposer()
  if (composer === undefined) return { ok: false, text, reason: '没有找到输入框（会话未挂载？）' }
  composer.focus()
  const selection = window.getSelection()
  if (selection !== null) {
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  try {
    // execCommand is the only cross-editor way to insert text so that the rich
    // editor's own model (and therefore React state) sees the change.
    const inserted = document.execCommand('insertText', false, text)
    if (inserted) return { ok: true, text }
  } catch {
    // fall through to the manual path below
  }
  try {
    const node = document.createTextNode(text)
    const selection2 = window.getSelection()
    const range2 = selection2?.rangeCount !== undefined && selection2.rangeCount > 0 ? selection2.getRangeAt(0) : null
    if (range2 === null) {
      composer.appendChild(node)
    } else {
      range2.deleteContents()
      range2.insertNode(node)
      range2.collapse(false)
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    return { ok: true, text }
  } catch (error) {
    return { ok: false, text, reason: String((error as Error)?.message ?? error) }
  }
}
