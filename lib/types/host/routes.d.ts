import type { Context } from '@deepseek-ai/cordis';
import { type CodeServerOptions } from './code-server.js';
/** Route prefix owned by this plugin. */
export declare const ROUTE_PREFIX = "/dsh-file-tree";
/** Limits the panel also reads back, so both halves agree on the caps. */
export interface RouteOptions {
    readonly readLimitBytes: number;
    readonly imageLimitBytes: number;
    readonly listLimit: number;
    readonly searchLimit: number;
    /** code-server knobs, or undefined when the embedded editor is switched off. */
    readonly codeServer?: CodeServerOptions;
}
/**
 * Mount the plugin's HTTP surface.
 *
 * Two routes, because they have nothing in common: one JSON API under
 * `/dsh-file-tree/*` for the tree, previews and search, and one reverse-proxy
 * route under `/dsh-file-tree/code-server/*` that carries an embedded VS Code
 * workbench. The web server matches the longest prefix, so the second route
 * takes precedence for its own subtree and neither can shadow the other.
 *
 * @param ctx - host context (needs `webServer` and `sessions`).
 * @param options - resolved plugin configuration, echoed back to the browser half.
 * @returns disposer removing both routes.
 */
export declare function registerRoutes(ctx: Context, options: RouteOptions): () => void;
