import type { Context } from '@deepseek-ai/cordis';
/** Route prefix owned by this plugin. */
export declare const ROUTE_PREFIX = "/dsh-file-tree";
/** Limits the panel also reads back, so both halves agree on the caps. */
export interface RouteOptions {
    readonly readLimitBytes: number;
    readonly imageLimitBytes: number;
    readonly listLimit: number;
    readonly searchLimit: number;
}
/**
 * Mount the plugin's HTTP surface.
 * @param ctx - host context (needs `webServer` and `sessions`).
 * @param options - resolved plugin configuration, echoed back to the browser half.
 * @returns disposer removing the route.
 */
export declare function registerRoutes(ctx: Context, options: RouteOptions): () => void;
