/**
 * Reverse proxy that puts a code-server workbench under a DSH-origin path.
 *
 * code-server 4.138 removed `--base-path`, so the prefix cannot come from the
 * workbench itself. It does not need to: the served HTML and its workbench
 * configuration are entirely relative (`serverBasePath: "."`, `rootEndpoint:
 * "."`), so stripping a prefix on the way through keeps every asset, socket and
 * redirect inside the prefix. That was measured, not assumed: a workbench
 * driven through this proxy issues zero requests outside it.
 *
 * Three details are load-bearing and each produces a confusing failure when
 * missing (all three were isolated experimentally):
 *
 * 1. **`sec-websocket-key` must reach the upstream.** Without it the upgrade is
 *    just an HTTP GET to a socket route, and code-server answers 404.
 * 2. **The upstream leg must carry an explicit `Connection: Upgrade` +
 *    `Upgrade: websocket` pair.** Relying on the HTTP client to add them for an
 *    upgrade listener that lives on the *upstream* request does not fire here,
 *    which also lands on 404.
 * 3. **The caller's `Host` must be forwarded unchanged.** code-server's
 *    `authenticateOrigin()` compares the `Origin` header's host against the
 *    request `Host`; rewriting Host to `127.0.0.1:<port>` makes them mismatch and
 *    every socket is refused with 403.
 *
 * WebSocket routing is the other half of the problem: `webServer.registerUpgrade`
 * only accepts exact paths, and a workbench's socket path carries a version hash
 * plus a query string. The prefix is therefore intercepted one level lower, on
 * the HTTP server's `upgrade` event, and anything outside this plugin's prefix is
 * handed back to DSH's own listener untouched.
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
/**
 * Proxy one HTTP request to the workbench that owns the path.
 * @param request - the incoming request.
 * @param response - the response to own.
 * @param pathname - the request path (already parsed by the caller).
 * @returns whether this plugin claimed the request.
 */
export declare function proxyHttp(request: IncomingMessage, response: ServerResponse, pathname: string): boolean;
/**
 * Proxy one WebSocket upgrade to the workbench that owns the path.
 * @param request - the upgrade request.
 * @param socket - the raw client socket, owned here after this call.
 * @param head - bytes already read from the client.
 * @returns whether this plugin claimed the upgrade.
 */
export declare function proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
/**
 * Route `upgrade` events for this plugin's prefix, leaving every other event to
 * the listeners DSH already registered.
 *
 * `http.Server#emit` is wrapped rather than a listener added, because node calls
 * *every* `upgrade` listener: an added listener would run before DSH's, whose
 * "no exact route matched" branch destroys the socket. The wrapper claims the
 * matching events outright and forwards the rest untouched.
 *
 * @param ctx - host context carrying `webServer`.
 * @returns the disposer restoring the original `emit`.
 */
export declare function interceptUpgrades(ctx: Context): () => void;
