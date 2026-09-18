import z from 'schemastery';
import { registerRoutes } from './host/routes.js';
/** Plugin identity, as the loader records it. */
export const name = 'dsh-file-tree';
/** Services this half needs; the panel cannot work without either. */
export const inject = ['webServer', 'sessions'];
export const Config = z.object({
    readLimitBytes: z.number().default(512 * 1024),
    imageLimitBytes: z.number().default(3 * 1024 * 1024),
    listLimit: z.number().default(2000),
    searchLimit: z.number().default(200),
});
/**
 * Mount the filesystem route.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
    const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.floor(value)));
    const options = {
        readLimitBytes: clamp(config.readLimitBytes, 1024, 8 * 1024 * 1024),
        imageLimitBytes: clamp(config.imageLimitBytes, 0, 16 * 1024 * 1024),
        listLimit: clamp(config.listLimit, 50, 20_000),
        searchLimit: clamp(config.searchLimit, 10, 2000),
    };
    ctx.effect(() => registerRoutes(ctx, options), 'dsh-file-tree: filesystem routes');
}
//# sourceMappingURL=index.js.map