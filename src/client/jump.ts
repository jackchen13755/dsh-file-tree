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

/** Quoted strings and bare path-looking words, e.g. `./a`, `../b/c.ts`, `src/app/x.tsx`. */
export function specifierLike(token: string): string | undefined {
  const trimmed = token.trim().replace(/^['"`]|['"`]$/g, '')
  if (trimmed === '' || /\s/.test(trimmed)) return undefined
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) return trimmed
  // A path-shaped string inside the workspace: has a slash and a known-looking suffix.
  if (/^[\w.-]+(\/[\w.-]+)+$/.test(trimmed)) return trimmed
  // A quoted bare name is a package: hand it to the host so the panel can say
  // "that is a package, not a workspace file" instead of "no definition found".
  if (/^['"`]/.test(token.trim()) && /^[@\w][\w./@-]*$/.test(trimmed)) return trimmed
  return undefined
}

/**
 * An import/export-from statement. These never DECLARE anything a click should
 * land on — their brace lists are what made the loose object-key pattern fire on
 * `import { Button } from './index'` and report "the definition is on this line".
 */
const MODULE_STATEMENT = /^\s*(?:import|export)\b[^\n]*\bfrom\b|^\s*import\b/

/** Declaration shapes searched for, most specific first. */
function declarationPatterns(name: string): RegExp[] {
  // Sigils carry meaning: `@x`/`$x` are LESS/SCSS variables, `.x` names a class or
  // mixin. Patterns are built from the bare name so each shape can be matched.
  const bare = name.replace(/^[@$.]+/, '')
  if (bare === '') return []
  const escaped = escapeRegExp(bare)
  const boundary = `\\b${escaped}\\b`
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${boundary}`),
    new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${boundary}`),
    new RegExp(`\\b(?:export\\s+)?interface\\s+${boundary}`),
    new RegExp(`\\b(?:export\\s+)?type\\s+${boundary}\\s*[=<]`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${boundary}`),
    new RegExp(`\\b(?:export\\s+)?enum\\s+${boundary}`),
    // Destructuring bindings: `const { a, b } = …` / `const [x] = …`.
    new RegExp(`\\b(?:const|let|var)\\s*(?:\\{[^}]*${boundary}[^}]*\\}|\\[[^\\]]*${boundary}[^\\]]*\\])`),
    // A re-export binding: `export { name } from './x'` (React barrels).
    new RegExp(`^\\s*export\\s*(?:type\\s*)?\\{[^}]*${boundary}[^}]*\\}`),
    // Parameter / argument destructuring, where no keyword precedes the braces:
    // `function Card({ title, onClick }: Props)` and `({ item }) => …`.
    new RegExp(`[(,]\\s*\\{[^}]*${boundary}[^}]*\\}`),
    // LESS / SCSS variables: `@gap: 8px;` / `$gap: 8px;`.
    new RegExp(`^\\s*[@$]${escaped}\\s*:`),
    // Class member / method / property starting a line.
    new RegExp(`^\\s*(?:public|private|protected|readonly|static|async|get|set|\\*)?\\s*${boundary}\\s*[(?]`),
    new RegExp(`^\\s*${boundary}\\s*[:=]`),
  ]
  if (/^[A-Za-z]/.test(bare)) {
    // Inline object key / shorthand: `{ name: … }`, `(, name)`, `{ name,`.
    patterns.push(new RegExp(`[,{;]\\s*${boundary}\\s*[:=(,}]`))
    // A LESS mixin or CSS class declaration, then a Vue template's class="…".
    patterns.push(new RegExp(`^\\s*\\.${escaped}\\s*[{(,:]`))
    patterns.push(new RegExp(`class=["'][^"']*\\b${escaped}\\b`))
  }
  return patterns
}

/**
 * First line that plausibly declares `name`, 1-based.
 * @param lines - the file's lines.
 * @param name - the clicked identifier.
 */
export function findDeclarationLine(lines: readonly string[], name: string): number | undefined {
  if (name === '') return undefined
  for (const pattern of declarationPatterns(name)) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (MODULE_STATEMENT.test(line)) continue
      if (pattern.test(line)) return index + 1
    }
  }
  return undefined
}

/**
 * The line that re-exports `name` onward, used as a landing spot when the
 * onward file cannot be resolved.
 * @param lines - the file's lines.
 * @param name - the clicked identifier.
 */
export function findReexportLine(lines: readonly string[], name: string): number | undefined {
  const wanted = new RegExp(`\\b${escapeRegExp(name)}\\b`)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const statement = /^\s*export\s+(?:\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/.exec(line)
    if (statement === null) continue
    const bindings = statement[1]
    if (bindings === undefined || wanted.test(bindings)) return index + 1
  }
  return undefined
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Characters that make up a file path or an identifier. */
const WORD_CHARACTER = /[\w$./@\\-]/

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
export function wordAtPoint(x: number, y: number): string | undefined {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  const range = doc.caretRangeFromPoint?.(x, y)
  if (range !== null && range !== undefined) {
    node = range.startContainer
    offset = range.startOffset
  } else {
    const position = doc.caretPositionFromPoint?.(x, y)
    if (position !== null && position !== undefined) {
      node = position.offsetNode
      offset = position.offset
    }
  }
  if (node === null || node.nodeType !== 3) return undefined
  const text = node.textContent ?? ''
  if (text === '') return undefined
  // Expand around the caret to the surrounding path/identifier characters.
  let start = Math.min(offset, text.length)
  let end = start
  while (start > 0 && WORD_CHARACTER.test(text[start - 1] ?? '')) start -= 1
  while (end < text.length && WORD_CHARACTER.test(text[end] ?? '')) end += 1
  let word = text.slice(start, end)
  // Adjacent quotes are part of a specifier's presentation, not of its value.
  word = word.replace(/^['"`]+|['"`]+$/g, '').replace(/[.,;:]+$/g, '')
  return word === '' ? undefined : word
}

/** The element that wraps one rendered source line, inside a CodeBlock-like body. */

/**
 * The specifier a name is imported from, when the file binds it with a relative
 * import or require — the one cross-file case this panel can follow honestly.
 * @param lines - the file's lines.
 * @param name - the clicked identifier.
 * @returns the raw specifier, or undefined when the name is not imported.
 */
export function importedFrom(lines: readonly string[], name: string): string | undefined {
  const wanted = new RegExp(`\\b${escapeRegExp(name)}\\b`)
  for (const line of lines) {
    const statement = /^\s*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/.exec(line)
    if (statement === null) continue
    if (wanted.test(statement[1] ?? '')) return statement[2]
    // `import './side-effect'` binds nothing.
  }
  for (const line of lines) {
    const required = new RegExp(
      `\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${escapeRegExp(name)}\\b[^}]*\\}|[\\w$]+)\\s*=\\s*require\\(['"]([^'"]+)['"]\\)`,
    )
    const match = required.exec(line)
    if (match !== null && wanted.test(line)) return match[1]
  }
  return undefined
}

/**
 * The first relative path quoted on a line — a fallback for syntax highlighters
 * that split a string literal into several tokens, so the clicked token alone no
 * longer looks like a path.
 * @param lineText - the rendered line's text.
 */
export function quotedSpecifierOn(lineText: string): string | undefined {
  const match = /['"`](\.\.?\/[^'"`]+)['"`]/.exec(lineText)
  return match === null ? undefined : match[1]
}

/** The element that wraps one rendered source line, inside a CodeBlock-like body. */
export function lineElements(container: HTMLElement): HTMLElement[] {
  const content = container.querySelector<HTMLElement>('[data-code-block-content]') ?? container
  const byAttribute = [...content.querySelectorAll<HTMLElement>('[data-textpreview-line]')]
  if (byAttribute.length > 0) return byAttribute
  const byClass = [...content.querySelectorAll<HTMLElement>('.line')]
  if (byClass.length > 0) return byClass
  // The product's own preview renders through CodeMirror: one element per line.
  const byCodeMirror = [...container.querySelectorAll<HTMLElement>('.cm-line')]
  if (byCodeMirror.length > 0) return byCodeMirror
  const pre = content.querySelector('pre')
  if (pre !== null) {
    const children = [...pre.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
    if (children.length > 1) return children
  }
  const code = content.querySelector('code')
  if (code !== null) {
    const children = [...code.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
    if (children.length > 1) return children
  }
  return []
}

/**
 * The rendered line index (1-based) that contains an element, or undefined.
 * @param container - the preview body.
 * @param element - the clicked token element.
 */
export function lineIndexOf(container: HTMLElement, element: Element | null): number | undefined {
  const elements = lineElements(container)
  if (elements.length === 0) return undefined
  let node: Element | null = element
  while (node !== null) {
    const index = elements.indexOf(node as HTMLElement)
    if (index >= 0) return index + 1
    node = node.parentElement
  }
  return undefined
}

/**
 * Scroll a line into view and flash it, so a same-file jump is visible.
 * @param container - the scrollable preview body.
 * @param line - 1-based line number.
 * @returns whether that line is rendered.
 */
export function revealLine(container: HTMLElement, line: number): boolean {
  const target = lineElements(container)[line - 1]
  if (target === undefined) return false
  target.scrollIntoView({ block: 'center' })
  const previous = target.style.backgroundColor
  const previousTransition = target.style.transition
  target.style.transition = 'background-color 120ms ease-in'
  target.style.backgroundColor = 'var(--dsw-alias-bg-3, rgba(77,107,254,.28))'
  setTimeout(() => {
    target.style.backgroundColor = previous
    target.style.transition = previousTransition
  }, 900)
  return true
}

/**
 * Underline the token under a Ctrl/Cmd-held cursor, so jumpable targets are
 * visible before the click. Returns a disposer that clears the highlight.
 * @param container - the preview body.
 */
export function trackJumpAffordance(container: HTMLElement): () => void {
  let highlighted: HTMLElement | undefined
  const clear = (): void => {
    if (highlighted !== undefined) {
      highlighted.style.textDecoration = ''
      highlighted.style.cursor = ''
      highlighted = undefined
    }
  }
  const onMove = (event: MouseEvent): void => {
    if (!event.ctrlKey && !event.metaKey) {
      clear()
      return
    }
    const target = (event.target as HTMLElement | null)?.closest('span') as HTMLElement | null
    if (target === null || (target.textContent ?? '').trim() === '') {
      clear()
      return
    }
    if (highlighted === target) return
    clear()
    highlighted = target
    target.style.textDecoration = 'underline'
    target.style.cursor = 'pointer'
  }
  const onLeave = (): void => clear()
  const onKeyUp = (): void => clear()
  container.addEventListener('mousemove', onMove)
  container.addEventListener('mouseleave', onLeave)
  window.addEventListener('keyup', onKeyUp)
  return () => {
    clear()
    container.removeEventListener('mousemove', onMove)
    container.removeEventListener('mouseleave', onLeave)
    window.removeEventListener('keyup', onKeyUp)
  }
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
export function memberReceiver(lineText: string, token: string): string | undefined {
  const at = lineText.indexOf(token)
  if (at <= 0) return undefined
  let index = at - 1
  while (index >= 0 && /\s/.test(lineText[index] ?? '')) index -= 1
  if (lineText[index] !== '.') return undefined
  index -= 1
  if (lineText[index] === '?') index -= 1
  const end = index + 1
  while (index >= 0 && /[\w$]/.test(lineText[index] ?? '')) index -= 1
  const receiver = lineText.slice(index + 1, end)
  return receiver === '' ? undefined : receiver
}

/**
 * A re-export that carries `name` onward: `export { name } from './x'` or a bare
 * `export * from './x'`.
 *
 * React code is full of barrel files (`components/index.ts`), and without this a
 * click on a symbol imported from a barrel would stop at the barrel's first line.
 *
 * @param lines - the candidate file's lines.
 * @param name - the clicked identifier.
 * @returns the specifier to follow, or undefined when the file does not re-export.
 */
export function reexportedFrom(lines: readonly string[], name: string): string | undefined {
  const wanted = new RegExp(`\\b${escapeRegExp(name)}\\b`)
  for (const line of lines) {
    const statement = /^\s*export\s+(?:\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/.exec(line)
    if (statement === null) continue
    const bindings = statement[1]
    if (bindings === undefined) return statement[2]
    if (wanted.test(bindings)) return statement[2]
  }
  return undefined
}

/**
 * The quoted specifier a token sits INSIDE, if any.
 *
 * `quotedSpecifierOn` answers "does this line contain a path?", which is the
 * wrong question when the click landed on a symbol: in
 * `import { Button } from './index'` a click on `Button` must jump to `Button`,
 * not open `./index`. Position is what separates the two cases.
 *
 * @param lineText - the rendered line's text.
 * @param token - the clicked identifier.
 * @returns the quoted path containing the token, or undefined.
 */
export function quotedSpecifierAt(lineText: string, token: string): string | undefined {
  const quoted = /['"`]([^'"`]*)['"`]/g
  let match = quoted.exec(lineText)
  while (match !== null) {
    const inner = match[1] ?? ''
    if (inner.includes(token) && specifierLike(inner) !== undefined) return inner
    match = quoted.exec(lineText)
  }
  return undefined
}
