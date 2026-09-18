/**
 * Module-alias discovery for the workspace.
 *
 * A project resolves `isomorph/components/RouterWrapper` neither relative nor
 * from node_modules: it is an alias (here a `tsconfig.json` path mapping). This
 * module collects what a workspace actually declares, cheapest source first:
 *
 *   - `tsconfig.json` / `jsconfig.json` → `compilerOptions.baseUrl` + `paths`
 *     (read with brace matching + a targeted regex rather than a JSON parser,
 *     because real ones carry comments);
 *   - webpack-style configs → `resolve.alias` entries and `resolve.modules`
 *     roots, matched textually (a JS config cannot be evaluated safely).
 *
 * Everything is best-effort and cached briefly: a miss only means the jump says
 * it cannot resolve, never that it resolves to the wrong file.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** One alias rule: a specifier prefix mapped to workspace-relative targets. */
export interface AliasRule {
  /** Specifier prefix, without the trailing `*`. */
  readonly prefix: string
  /** Whether the rule matches only that exact specifier. */
  readonly exact: boolean
  /** Candidate targets, workspace-relative (`*` is substituted when present). */
  readonly targets: readonly string[]
  /** Where the rule came from, for the jump's message. */
  readonly source: string
}

/** Alias rules plus extra module roots a workspace resolves bare specifiers from. */
export interface AliasTable {
  readonly rules: readonly AliasRule[]
  /** Workspace-relative directories tried before `node_modules` (e.g. `src`). */
  readonly roots: readonly string[]
}

const CACHE_TTL_MS = 10_000
const cache = new Map<string, { at: number; table: AliasTable }>()

/** Config files worth reading for aliases, relative to the workspace root. */
const TSCONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']
const WEBPACK_CANDIDATES = [
  'webpack.config.js',
  'vue.config.js',
  'vite.config.js',
  'vite.config.ts',
  'config/webpack/base.js',
  'config/webpack/webpack.base.js',
  'config/webpack/webpack.config.js',
  'build/webpack.base.conf.js',
]

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}

/** Strip `//` and block comments plus trailing commas, so JSON.parse can cope. */
function relaxJson(text: string): string {
  return text
    .replace(/"(?:[^"\\]|\\.)*"/g, match => match.replace(/\/\//g, '\u0000'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\u0000/g, '//')
    .replace(/,(\s*[}\]])/g, '$1')
}

/** Extract a balanced `{...}` block that starts at or after `from`. */
function blockFrom(text: string, from: number): string | undefined {
  const open = text.indexOf('{', from)
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  return undefined
}

/** `compilerOptions.baseUrl` from a tsconfig text. */
function baseUrlOf(text: string): string {
  const match = /"baseUrl"\s*:\s*"([^"]*)"/.exec(text)
  return match?.[1]?.trim() ?? ''
}

/** The `paths` entries of a tsconfig text, as alias rules. */
function pathsOf(text: string, baseUrl: string, source: string): AliasRule[] {
  const key = text.search(/"paths"\s*:/)
  if (key < 0) return []
  const block = blockFrom(text, key)
  if (block === undefined) return []
  const rules: AliasRule[] = []
  const entry = /"([^"]+)"\s*:\s*\[([^\]]*)\]/g
  let match = entry.exec(block)
  while (match !== null) {
    const wildcard = match[1] ?? ''
    const targets = [...(match[2] ?? '').matchAll(/"([^"]+)"/g)]
      .map(target => target[1] ?? '')
      .filter(target => target !== '')
      .map(target => join(baseUrl, target))
    if (wildcard !== '' && targets.length > 0) {
      rules.push({
        prefix: wildcard.endsWith('*') ? wildcard.slice(0, -1) : wildcard,
        exact: !wildcard.endsWith('*'),
        targets,
        source,
      })
    }
    match = entry.exec(block)
  }
  return rules
}

/** webpack-style `alias: { name: resolve(__dirname, 'dir') }` entries. */
function webpackAliasesOf(text: string, source: string): AliasRule[] {
  const rules: AliasRule[] = []
  const aliasKey = text.search(/alias\s*:/)
  if (aliasKey >= 0) {
    const block = blockFrom(text, aliasKey)
    if (block !== undefined) {
      const entry = /['"]?([@\w./-]+)['"]?\s*:\s*(?:path\.)?resolve\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g
      let match = entry.exec(block)
      while (match !== null) {
        const name = match[1] ?? ''
        const target = (match[2] ?? '').replace(/^\.\//, '')
        if (name !== '' && target !== '') rules.push({ prefix: name, exact: true, targets: [target], source })
        match = entry.exec(block)
      }
    }
  }
  return rules
}

/** webpack-style `resolve.modules: [ ..., 'src' ]` roots. */
function webpackRootsOf(text: string): string[] {
  const key = text.search(/modules\s*:/)
  if (key < 0) return []
  const block = blockFrom(text, text.indexOf('[', key))
  if (block === undefined) return []
  return [...block.matchAll(/['"]([^'"]+)['"]/g)]
    .map(match => (match[1] ?? '').replace(/^\.\//, ''))
    .filter(value => value !== '' && value !== 'node_modules' && !isAbsolute(value))
}

/**
 * Build (or reuse) the alias table of one workspace.
 * @param workspace - the session's workspace root.
 */
export async function aliasTable(workspace: string): Promise<AliasTable> {
  const hit = cache.get(workspace)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.table
  const rules: AliasRule[] = []
  const roots = new Set<string>()
  for (const name of TSCONFIG_NAMES) {
    const path = join(workspace, name)
    if (!(await exists(path))) continue
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text === '') continue
    const baseUrl = baseUrlOf(text)
    rules.push(...pathsOf(text, baseUrl, name))
    if (baseUrl !== '' && baseUrl !== '.') roots.add(baseUrl.replace(/^\.\//, ''))
  }
  for (const name of WEBPACK_CANDIDATES) {
    const path = join(workspace, name)
    if (!(await exists(path))) continue
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text === '') continue
    rules.push(...webpackAliasesOf(text, name))
    for (const root of webpackRootsOf(text)) roots.add(root)
  }
  // `src` is the overwhelmingly common source root; try it when it exists.
  if (await isDirectory(join(workspace, 'src'))) roots.add('src')
  const table: AliasTable = { rules, roots: [...roots] }
  cache.set(workspace, { at: Date.now(), table })
  return table
}

/**
 * Resolve a specifier through the alias table.
 * @param specifier - the raw specifier from the source.
 * @param table - the workspace's alias table.
 * @returns workspace-relative base candidates, most specific rule first.
 */
export function aliasCandidates(specifier: string, table: AliasTable): Array<{ base: string; source: string }> {
  const out: Array<{ base: string; source: string }> = []
  const sorted = [...table.rules].sort((left, right) => right.prefix.length - left.prefix.length)
  for (const rule of sorted) {
    if (rule.exact) {
      if (specifier !== rule.prefix) continue
      for (const target of rule.targets) out.push({ base: target, source: rule.source })
      continue
    }
    if (!specifier.startsWith(rule.prefix)) continue
    const rest = specifier.slice(rule.prefix.length)
    for (const target of rule.targets) {
      out.push({ base: target.includes('*') ? target.replace('*', rest) : `${target}${rest}`, source: rule.source })
    }
  }
  for (const root of table.roots) out.push({ base: `${root}/${specifier}`.replace(/^\.\//, ''), source: root === 'src' ? 'src 根目录' : `模块根 ${root}` })
  return out
}

/** Directory names read at the workspace root, for a quick "does this top-level dir exist" probe. */
export async function topLevelDirectories(workspace: string): Promise<Set<string>> {
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
}
