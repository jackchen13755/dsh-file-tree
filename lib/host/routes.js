import { isLoopback, sessionRoot } from './fence.js';
import { listDirectory, readPreview, searchFiles } from './files.js';
import { webServerOf } from './services.js';
/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-file-tree';
const MAX_BODY_BYTES = 64 * 1024;
function fail(code, message, detail) {
    return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}
async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk;
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            return null;
        chunks.push(buffer);
    }
    if (size === 0)
        return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    }
    catch {
        return null;
    }
}
function send(response, status, payload) {
    const text = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(text);
}
/**
 * Mount the plugin's HTTP surface.
 * @param ctx - host context (needs `webServer` and `sessions`).
 * @param options - resolved plugin configuration, echoed back to the browser half.
 * @returns disposer removing the route.
 */
export function registerRoutes(ctx, options) {
    const handler = async (request, response) => {
        try {
            if (!isLoopback(request)) {
                send(response, 403, fail('forbidden', 'dsh-file-tree is loopback-only'));
                return;
            }
            if (request.method !== 'POST') {
                send(response, 405, fail('method', 'POST required'));
                return;
            }
            const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
            const operation = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : '';
            if (operation === '' || operation.includes('/')) {
                send(response, 404, fail('not-found', 'unknown route'));
                return;
            }
            const body = await readBody(request);
            if (body === null) {
                send(response, 400, fail('bad-body', 'a JSON body is required'));
                return;
            }
            const sessionId = str(body.sessionId);
            if (sessionId === '') {
                send(response, 400, fail('no-session', 'sessionId is required'));
                return;
            }
            const workspace = sessionRoot(ctx, sessionId);
            if (workspace === undefined) {
                send(response, 403, fail('unknown-session', 'the session has no working directory'));
                return;
            }
            const relative = str(body.path);
            switch (operation) {
                case 'context': {
                    send(response, 200, { ok: true, value: { workspace, options } });
                    return;
                }
                case 'list': {
                    const listed = await listDirectory(workspace, relative, options.listLimit);
                    if (listed === null) {
                        send(response, 404, fail('not-a-directory', `cannot list: ${relative === '' ? '.' : relative}`));
                        return;
                    }
                    send(response, 200, { ok: true, value: listed });
                    return;
                }
                case 'read': {
                    const preview = await readPreview(workspace, relative, options.readLimitBytes, options.imageLimitBytes);
                    if (preview === null) {
                        send(response, 404, fail('not-a-file', `cannot read: ${relative}`));
                        return;
                    }
                    send(response, 200, { ok: true, value: preview });
                    return;
                }
                case 'search': {
                    const query = str(body.query);
                    const hits = await searchFiles(workspace, query, options.searchLimit, 6);
                    send(response, 200, { ok: true, value: { query, hits } });
                    return;
                }
                default:
                    send(response, 404, fail('unknown-op', `unknown operation: ${operation}`));
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger?.warn?.(error instanceof Error ? error : new Error(message));
            if (!response.headersSent)
                send(response, 500, fail('internal', message));
            else
                response.end();
        }
    };
    return webServerOf(ctx).register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
}
//# sourceMappingURL=routes.js.map