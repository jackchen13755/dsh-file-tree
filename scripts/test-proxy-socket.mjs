#!/usr/bin/env node
/**
 * Regression test for the code-server upgrade proxy crash.
 *
 * A socket whose peer sends FIN ends its own writable side (`allowHalfOpen`
 * defaults to false on connect() sockets), and from then on every write to it
 * raises `EPIPE` ("This socket has been ended by the other party") from
 * `writeAfterFIN`. The proxy used a bare
 * `socket.pipe(upstream).pipe(socket)`, which attaches no `error` listener to
 * either leg, so one late frame from the browser while the workbench socket was
 * already finished killed the whole DSH process — switching session with the
 * editor open was enough. See `bridgeSockets` in `src/host/proxy.ts`.
 *
 * The scenario is driven from the destination socket's `finish` event instead
 * of racing the network: at that instant `writableEnded` is true and the socket
 * is not yet destroyed, which is exactly the window the old code died in.
 *
 *   node scripts/test-proxy-socket.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { connect, createServer } from 'node:net'

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2]

if (mode === 'plain' || mode === 'guard') {
  const { bridgeSockets } = await import('../lib/host/proxy.js')
  // `plain` reproduces the old code; `guard` exercises the fix.
  const bridge =
    mode === 'guard'
      ? bridgeSockets
      : (client, upstream) => {
          client.pipe(upstream).pipe(client)
        }

  let peerSocket
  const peer = createServer({ allowHalfOpen: true }, socket => {
    peerSocket = socket
  })
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve))

  const upstream = connect(peer.address().port, '127.0.0.1')
  await new Promise(resolve => upstream.once('connect', resolve))

  // The browser leg never auto-destroys, so the only event under test is the
  // late byte — not the teardown of the stand-in.
  const client = new PassThrough({ autoDestroy: false })
  bridge(client, upstream)

  upstream.on('finish', () => {
    assert.equal(upstream.writableEnded, true)
    assert.equal(upstream.destroyed, false)
    upstream.write(Buffer.from('late bytes'))
  })

  await new Promise(resolve => setTimeout(resolve, 50))
  peerSocket.end()
  await new Promise(resolve => setTimeout(resolve, 300))
  console.log(`[${mode}] survived the finished-socket write`)
  process.exit(0)
}

const plain = spawnSync(process.execPath, [self, 'plain'], { encoding: 'utf8' })
assert.notEqual(plain.status, 0, 'the unguarded pipe must still reproduce the crash')
assert.match(plain.stderr, /writeAfterFIN/, `expected writeAfterFIN in the crash:\n${plain.stderr}`)
assert.match(plain.stderr, /EPIPE/, `expected EPIPE in the crash:\n${plain.stderr}`)

const guard = spawnSync(process.execPath, [self, 'guard'], { encoding: 'utf8' })
assert.equal(guard.status, 0, `the bridged sockets must survive:\n${guard.stderr}`)
assert.match(guard.stdout, /survived the finished-socket write/)

console.log('ok — finished-socket writes crash the bare pipe and are contained by bridgeSockets')
