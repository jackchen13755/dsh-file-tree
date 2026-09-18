/**
 * The jump decision, shared by the two places a user can Ctrl/Cmd-click:
 * this panel's inline preview, and the product's own preview tab.
 *
 * Four levels, each falling through to the next with an explanation rather than
 * a silent no-op:
 *
 *   1. a declaration in the file already on screen → reveal that line;
 *   2. a module specifier → resolve it and open the target;
 *   3. a symbol imported by a relative import → follow it to its declaration;
 *   4. a member access whose RECEIVER is imported → follow the receiver and look
 *      the member up there.
 */
import { findDeclarationLine, importedFrom, memberReceiver, quotedSpecifierOn, specifierLike } from './jump.js'

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
  /** Resolve a specifier against this session's workspace. */
  readonly resolve: (specifier: string) => Promise<{ path: string | null; reason?: string }>
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

function specifierFailure(host: JumpHost, specifier: string, reason: string | undefined): void {
  host.notify(
    'error',
    reason === 'bare-specifier'
      ? `「${specifier}」是包名，本面板不做 node_modules 解析`
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

/**
 * Decide and perform one jump.
 * @param host - the caller's environment.
 */
export async function runJump(host: JumpHost): Promise<void> {
  const { token, lines } = host
  if (token === '') return

  // Module specifier (either the clicked token itself, or the quoted path on the
  // clicked line when a highlighter split the literal).
  const specifier = specifierLike(token) ?? quotedSpecifierOn(host.lineText)
  if (specifier !== undefined) {
    const result = await host.resolve(specifier)
    if (result.path === null) {
      specifierFailure(host, specifier, result.reason)
      return
    }
    openTarget(host, result.path, undefined, `由 ${host.path} 的「${specifier}」解析`)
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

  // 2. imported by name?
  const imported = importedFrom(lines, token)
  if (imported !== undefined) {
    const result = await host.resolve(imported)
    if (result.path === null) {
      host.notify('error', `${token} 来自「${imported}」，但无法解析该模块`)
      return
    }
    const targetLines = await host.readLines(result.path)
    openTarget(host, result.path, findDeclarationLine(targetLines, token), `${token} 由「${imported}」导入`)
    return
  }

  // 3. member access whose receiver is imported?
  const receiver = memberReceiver(host.lineText, token)
  if (receiver !== undefined && receiver !== 'this') {
    const receiverSpecifier = importedFrom(lines, receiver)
    if (receiverSpecifier !== undefined) {
      const result = await host.resolve(receiverSpecifier)
      if (result.path === null) {
        host.notify('error', `${receiver} 来自「${receiverSpecifier}」，但无法解析该模块`)
        return
      }
      const targetLines = await host.readLines(result.path)
      openTarget(host, result.path, findDeclarationLine(targetLines, token), `${receiver}.${token} 的成员`)
      return
    }
  }

  host.notify(
    'error',
    receiver === undefined
      ? `没有找到「${token}」的定义（跨文件的符号解析需要语言服务，本面板只跟随相对 import）`
      : `没有找到「${token}」的定义：${receiver} 不是本文件导入的，成员定义需要语言服务`,
  )
}
