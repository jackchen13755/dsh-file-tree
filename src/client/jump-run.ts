/**
 * The jump decision, shared by the two places a user can Ctrl/Cmd-click:
 * this panel's inline preview, and the product's own preview tab.
 *
 * Levels, each falling through to the next with an explanation rather than a
 * silent no-op:
 *
 *   1. a declaration in the file already on screen → reveal that line;
 *   2. a module specifier → resolve it and open the target;
 *   3. a symbol imported by a relative/aliased import → follow it, **including
 *      through barrel files** (`components/index.ts` re-exporting the symbol);
 *   4. a member access whose RECEIVER is imported → follow the receiver.
 *
 * Written for the shapes React + TypeScript projects actually use: props
 * destructured in a signature, `interface Props` members, type literals on one
 * line, hooks bound by `const [x, setX] = useState()`, class fields as arrow
 * functions, and barrels that re-export a component from its own file.
 */
import {
  findDeclarationLine,
  importedFrom,
  memberReceiver,
  quotedSpecifierAt,
  findReexportLine,
  reexportedFrom,
  specifierLike,
} from './jump.js'

/** Everything the decision needs from its caller (panel or tab listener). */
export interface JumpHost {
  readonly sessionId: string
  /** The file whose text is on screen. */
  readonly path: string
  readonly lines: readonly string[]
  /** Where the click landed. */
  readonly token: string
  readonly lineText: string
  readonly line: number | undefined
  /** Resolve a specifier as written INSIDE `from` (which may be a barrel file). */
  readonly resolveFrom: (
    from: string,
    specifier: string,
  ) => Promise<{ path: string | null; reason?: string; rule?: string }>
  /** Read another file's lines. */
  readonly readLines: (path: string) => Promise<readonly string[]>
  /** Open a file in a native tab, optionally at a line. */
  readonly openResource: (path: string, line?: number) => { ok: boolean; reason?: string }
  /** Show a file in this panel instead (used for pictures). */
  readonly openInline: (path: string) => void
  /** Scroll/underline a line of the file on screen. */
  readonly revealLine: (line: number) => boolean
  readonly isImage: (path: string) => boolean
  readonly notify: (kind: 'info' | 'error', text: string) => void
}

/** How many module hops a symbol lookup may take (barrels chain). */
const MAX_HOPS = 3

function specifierFailure(host: JumpHost, specifier: string, reason: string | undefined): void {
  host.notify(
    'error',
    reason === 'bare-specifier'
      ? `「${specifier}」解析不到工作区文件（是包名，或别名未在项目配置里声明）`
      : `无法解析「${specifier}」（${reason ?? 'unknown'}）`,
  )
}

/** Open a resolved target — pictures inline, everything else in a preview tab. */
function openTarget(host: JumpHost, target: string, line: number | undefined, what: string): void {
  if (host.isImage(target)) {
    host.notify('info', `跳转到图片 ${target}（行内预览）`)
    host.openInline(target)
    return
  }
  const opened = host.openResource(target, line ?? 1)
  host.notify(
    opened.ok ? 'info' : 'error',
    opened.ok
      ? line === undefined
        ? `跳转到 ${target}（${what}）`
        : `跳转到 ${target} 第 ${line} 行（${what}）`
      : opened.reason ?? '打开失败',
  )
}

/** Where a symbol ends up after following imports, possibly through barrels. */
interface Located {
  readonly path: string
  readonly line: number | undefined
  /** Human note about the hops taken, e.g. `经 components/index.ts 再导出`. */
  readonly note: string
}

/**
 * Follow a specifier to the file that declares `token`, through barrel files.
 * @param host - the caller's environment.
 * @param from - the file the specifier is written in.
 * @param specifier - the module specifier.
 * @param token - the symbol being looked for.
 * @returns the located file (line undefined when no declaration was found).
 */
async function locateSymbol(
  host: JumpHost,
  from: string,
  specifier: string,
  token: string,
): Promise<Located | { error: string }> {
  let currentFrom = from
  let currentSpecifier = specifier
  const hops: string[] = []
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const result = await host.resolveFrom(currentFrom, currentSpecifier)
    if (result.path === null) return { error: `无法解析「${currentSpecifier}」` }
    const lines = await host.readLines(result.path)
    const line = findDeclarationLine(lines, token)
    // A hit on a re-export line is not the definition: keep going, and only fall
    // back to that line when the onward file cannot be followed.
    const hitIsReexport = line !== undefined && reexportedFrom([lines[line - 1] ?? ''], token) !== undefined
    if (line !== undefined && !hitIsReexport) return { path: result.path, line, note: hops.join(' → ') }
    // No declaration here: a barrel may forward it (`export { token } from './x'`).
    const onward = reexportedFrom(lines, token)
    if (onward === undefined) return { path: result.path, line, note: hops.join(' → ') }
    const hopNote = `经 ${result.path} 再导出`
    const nextFrom = result.path
    const resolvedNext = await host.resolveFrom(nextFrom, onward)
    if (resolvedNext.path === null) {
      // The barrel named a module that does not resolve: the re-export line is
      // still the most useful place to land.
      return { path: result.path, line: findReexportLine(lines, token), note: hops.join(' → ') }
    }
    hops.push(hopNote)
    currentFrom = nextFrom
    currentSpecifier = onward
  }
  return { path: currentFrom, line: undefined, note: hops.join(' → ') }
}

/**
 * Decide and perform one jump.
 * @param host - the caller's environment.
 */
export async function runJump(host: JumpHost): Promise<void> {
  const { token, lines } = host
  if (token === '') return

  // Module specifier (either the clicked token itself, or the quoted path on the
  // clicked line when a highlighter split the literal).
  const specifier = specifierLike(token) ?? quotedSpecifierAt(host.lineText, token)
  if (specifier !== undefined) {
    const result = await host.resolveFrom(host.path, specifier)
    if (result.path === null) {
      specifierFailure(host, specifier, result.reason)
      return
    }
    const rule = result.rule === undefined || result.rule === '' ? '' : `，规则 ${result.rule}`
    openTarget(host, result.path, undefined, `由 ${host.path} 的「${specifier}」解析${rule}`)
    return
  }

  // 1. declared in this file?
  const declared = findDeclarationLine(lines, token)
  if (declared !== undefined) {
    if (declared === host.line) {
      host.notify('info', `${token} 的定义就在本行`)
      return
    }
    if (host.revealLine(declared)) {
      host.notify('info', `跳到第 ${declared} 行（${token} 的定义）`)
      return
    }
  }

  // 2. imported by name (through barrels)?
  const imported = importedFrom(lines, token)
  if (imported !== undefined) {
    const located = await locateSymbol(host, host.path, imported, token)
    if ('error' in located) {
      host.notify('error', `${token} 来自「${imported}」，但${located.error}`)
      return
    }
    const via = located.note === '' ? '' : `，${located.note}`
    openTarget(host, located.path, located.line, `${token} 由「${imported}」导入${via}`)
    return
  }

  // 3. member access whose receiver is imported?
  const receiver = memberReceiver(host.lineText, token)
  if (receiver !== undefined && receiver !== 'this') {
    const receiverSpecifier = importedFrom(lines, receiver)
    if (receiverSpecifier !== undefined) {
      const located = await locateSymbol(host, host.path, receiverSpecifier, token)
      if ('error' in located) {
        host.notify('error', `${receiver} 来自「${receiverSpecifier}」，但${located.error}`)
        return
      }
      const via = located.note === '' ? '' : `，${located.note}`
      openTarget(host, located.path, located.line, `${receiver}.${token} 的成员${via}`)
      return
    }
  }

  host.notify(
    'error',
    receiver === undefined
      ? `没有找到「${token}」的定义（跨文件的符号解析需要语言服务，本面板只跟随 import 与 barrel 再导出）`
      : `没有找到「${token}」的定义：${receiver} 不是本文件导入的，成员定义需要语言服务`,
  )
}
