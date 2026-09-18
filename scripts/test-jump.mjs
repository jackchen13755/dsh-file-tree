/**
 * Unit test for the jump helpers the preview's Ctrl/Cmd-click handler calls.
 *
 * The browser-side click path needs a mounted panel and a real workspace, which
 * makes it awkward to assert on; the DECISIONS it makes are pure functions, so
 * they are tested here directly — including the fixtures that answer "can a
 * click on a method find it?".
 *
 *   node scripts/test-jump.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(label)
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ` ${detail}`}\n`)
}

// ── compile the module under test ───────────────────────────────────────────
const tsc = process.env.TSC ?? join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/.bin/tsc')
const outDir = mkdtempSync(join(tmpdir(), 'dsh-file-tree-jump-'))
try {
  execFileSync(tsc, [
    'src/client/jump.ts',
    '--outDir', outDir,
    '--module', 'commonjs',
    '--target', 'ES2022',
    '--moduleResolution', 'node10',
    '--ignoreDeprecations', '6.0',
    '--skipLibCheck',
    // TS 6: passing files on the command line must be explicit about the local tsconfig.
    '--ignoreConfig',
  ], { stdio: 'pipe' })
} catch (error) {
  process.stdout.write(`FAIL compile src/client/jump.ts: ${String(error?.stdout ?? error).slice(0, 400)}\n`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const jump = require(join(outDir, 'jump.js'))

// ── fixtures: the two "click a method" cases ────────────────────────────────
const service = [
  '/** A small service object. */',
  'export const service = {',
  '  doThing(value: number): number {',
  '    return value + 1',
  '  },',
  '  other(): string {',
  "    return 'x'",
  '  },',
  '}',
]
const consumer = [
  "import { service } from './service.js'",
  '',
  'class Local {',
  '  compute(): number {',
  '    return 41',
  '  }',
  '}',
  '',
  'export function run(): number {',
  '  return service.doThing(1) + new Local().compute()',
  '}',
]

// ── same-file method: the declaration line is found ─────────────────────────
check('same-file method resolves to its declaration line',
  jump.findDeclarationLine(consumer, 'compute') === 4,
  `got ${jump.findDeclarationLine(consumer, 'compute')}`)
check('cross-file method resolves inside the target file',
  jump.findDeclarationLine(service, 'doThing') === 3,
  `got ${jump.findDeclarationLine(service, 'doThing')}`)
check('a variable declaration still resolves',
  jump.findDeclarationLine(['const local = 2'], 'local') === 1)

// ── member receiver: what the click on `doThing` must follow ────────────────
check('member receiver is read from a call',
  jump.memberReceiver('  return service.doThing(1) + new Local().compute()', 'doThing') === 'service')
check('optional chaining is understood',
  jump.memberReceiver('  return api?.fetchThing()', 'fetchThing') === 'api')
check('this.receiver is reported as this',
  jump.memberReceiver('    return this.compute()', 'compute') === 'this')
check('a plain identifier has no receiver',
  jump.memberReceiver('const total = helper(1)', 'helper') === undefined)

// ── import following ────────────────────────────────────────────────────────
check('an imported receiver is traced to its module',
  jump.importedFrom(consumer, 'service') === './service.js')
check('a member name is NOT treated as an import',
  jump.importedFrom(consumer, 'doThing') === undefined)
check('named imports are traced too',
  jump.importedFrom(["import { helper } from './b.js'"], 'helper') === './b.js')
check('require() bindings are traced',
  jump.importedFrom(["const { thing } = require('./c.js')"], 'thing') === './c.js')

// ── specifier recognition ───────────────────────────────────────────────────
check('a quoted relative specifier is recognised',
  jump.specifierLike("'./b.js'") === './b.js')
check('a bare package name is not a path',
  jump.specifierLike('some-package') === undefined)
check('a QUOTED package name is passed through for the host to explain',
  jump.specifierLike("'some-package'") === 'some-package')
check('a split string literal is recovered from the line',
  jump.quotedSpecifierOn("import { helper } from './b.js'") === './b.js')

// ── variables ───────────────────────────────────────────────────────────────
check('a variable declared below its use is found',
  jump.findDeclarationLine(['const total = helper(1)', 'const local = 2'], 'local') === 2)
check('a destructured binding is found',
  jump.findDeclarationLine(['const { alpha, beta } = source()'], 'beta') === 1)
check('an array destructuring binding is found',
  jump.findDeclarationLine(['const [first, second] = pair'], 'second') === 1)
check('an inline object key is found',
  jump.findDeclarationLine(['const config = { retries: 3, timeout: 5 }'], 'timeout') === 1)
check('an exported const is found',
  jump.findDeclarationLine(['export const API_BASE = "/x"'], 'API_BASE') === 1)

// ── methods ─────────────────────────────────────────────────────────────────
check('a class method is found',
  jump.findDeclarationLine(['class Local {', '  compute(): number {', '    return 41', '  }', '}'], 'compute') === 2)
check('a Vue options method is found',
  jump.findDeclarationLine(['export default {', '  methods: {', '    doIt() {', '      return 1', '    },', '  },', '}'], 'doIt') === 3)
check('a class field arrow function is found',
  jump.findDeclarationLine(['class Panel {', '  handleClick = () => {}', '}'], 'handleClick') === 2)
check('a getter is found',
  jump.findDeclarationLine(['const vm = {', '  get size() {', '    return 1', '  },', '}'], 'size') === 2)

// ── Vue / LESS shapes ───────────────────────────────────────────────────────
check('a LESS variable is found',
  jump.findDeclarationLine(['@gap: 8px;', '.drop { margin: @gap; }'], '@gap') === 1)
check('an SCSS variable is found',
  jump.findDeclarationLine(['$brand: #4d6bfe;'], '$brand') === 1)
check('a template class reaches its style rule',
  jump.findDeclarationLine(['<template>', '  <div class="wrapper box">', '</template>', '<style>', '.wrapper {', '  display: flex;', '}', '</style>'], 'wrapper') === 5)
check('the sigil is not required for a style rule',
  jump.findDeclarationLine(['<style>', '.wrapper {', '}'], 'wrapper') === 2)

rmSync(outDir, { recursive: true, force: true })
process.stdout.write(failures.length === 0 ? '\ntest-jump: PASS\n' : `\ntest-jump: FAIL (${failures.length})\n`)
process.exit(failures.length === 0 ? 0 : 1)
