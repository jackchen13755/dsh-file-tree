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
import { request as httpRequest } from 'node:http';
import { CODE_SERVER_PREFIX, instanceFor } from './code-server.js';
import { webServerOf } from './services.js';
/** Headers that belong to one hop and must not be copied to the next. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
/**
 * The id in a `/dsh-file-tree/code-server/<id>/…` path.
 * @param pathname - the request path.
 * @returns the id and the path to ask the upstream for, or undefined when the path is not ours.
 */
function splitPrefix(pathname) {
    if (pathname !== CODE_SERVER_PREFIX && !pathname.startsWith(`${CODE_SERVER_PREFIX}/`))
        return undefined;
    const remainder = pathname.slice(CODE_SERVER_PREFIX.length).replace(/^\//, '');
    const slash = remainder.indexOf('/');
    const id = slash < 0 ? remainder : remainder.slice(0, slash);
    const rest = slash < 0 ? '/' : remainder.slice(slash);
    if (id === '')
        return undefined;
    return { id, rest: rest === '' ? '/' : rest };
}
/** Copy a request's headers, dropping hop-by-hop ones. */
function forwardableHeaders(request) {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined)
            continue;
        if (HOP_BY_HOP.has(key))
            continue;
        // `host` is deliberately kept: see note 3 in the module docblock.
        headers[key] = value;
    }
    return headers;
}
/** A plain-text refusal the panel can show verbatim. */
function refuse(response, status, text) {
    if (response.headersSent) {
        response.end();
        return;
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(text);
}
/**
 * Proxy one HTTP request to the workbench that owns the path.
 * @param request - the incoming request.
 * @param response - the response to own.
 * @param pathname - the request path (already parsed by the caller).
 * @returns whether this plugin claimed the request.
 */
export function proxyHttp(request, response, pathname) {
    const split = splitPrefix(pathname);
    if (split === undefined)
        return false;
    const target = instanceFor(split.id);
    if (target === undefined) {
        refuse(response, 503, 'code-server 尚未就绪：请在「文件面板」里重新打开编辑器。');
        return true;
    }
    const upstream = httpRequest({
        host: '127.0.0.1',
        port: target.port,
        method: request.method,
        path: `${split.rest}${new URL(request.url ?? '/', 'http://x').search}`,
        headers: forwardableHeaders(request),
    }, answer => {
        const headers = { ...answer.headers };
        // A strict CSP meant for a top-level page would block the workbench's own
        // workers and webviews once it is framed by the panel.
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
    });
    upstream.on('error', () => refuse(response, 502, 'code-server 连接失败。'));
    request.pipe(upstream);
    return true;
}
/**
 * Proxy one WebSocket upgrade to the workbench that owns the path.
 * @param request - the upgrade request.
 * @param socket - the raw client socket, owned here after this call.
 * @param head - bytes already read from the client.
 * @returns whether this plugin claimed the upgrade.
 */
export function proxyUpgrade(request, socket, head) {
    let pathname;
    try {
        pathname = new URL(request.url ?? '/', 'http://x').pathname;
    }
    catch {
        return false;
    }
    const split = splitPrefix(pathname);
    if (split === undefined)
        return false;
    const target = instanceFor(split.id);
    if (target === undefined) {
        socket.destroy();
        return true;
    }
    const upstream = httpRequest({
        host: '127.0.0.1',
        port: target.port,
        path: `${split.rest}${new URL(request.url ?? '/', 'http://x').search}`,
        headers: {
            ...forwardableHeaders(request),
            // Explicit, because the client's automatic upgrade pair does not fire for
            // this request shape (see note 2 in the module docblock).
            connection: 'Upgrade',
            upgrade: 'websocket',
        },
    });
    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
        const lines = Object.entries(answer.headers)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
        socket.write(`HTTP/1.1 101 ${answer.statusMessage ?? 'Switching Protocols'}\r\n${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length > 0)
            socket.write(upstreamHead);
        if (head.length > 0)
            upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
    });
    // An upgrade that comes back as a normal response was refused upstream; let the
    // client see nothing rather than a half-open socket.
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
    return true;
}
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
export function interceptUpgrades(ctx) {
    const server = rawServer(ctx);
    if (server === undefined) {
        ctx.logger?.warn?.(new Error('dsh-file-tree: webServer exposes no raw http server; the code-server panel will load but its sockets will not connect'));
        return () => { };
    }
    const original = server.emit;
    const patched = function patchedEmit(event, ...args) {
        if (event === 'upgrade' && args.length >= 2) {
            const request = args[0];
            const socket = args[1];
            const head = (args[2] ?? Buffer.alloc(0));
            try {
                if (proxyUpgrade(request, socket, head))
                    return true;
            }
            catch (error) {
                ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
            }
        }
        return original.apply(this, [event, ...args]);
    };
    server.emit = patched;
    return () => {
        if (server.emit === patched)
            server.emit = original;
    };
}
/** The underlying `http.Server` behind the host web server, when it exposes one. */
function rawServer(ctx) {
    const candidate = webServerOf(ctx).server;
    if (candidate === undefined || candidate === null)
        return undefined;
    if (typeof candidate.emit !== 'function')
        return undefined;
    return candidate;
}
//# sourceMappingURL=proxy.js.map