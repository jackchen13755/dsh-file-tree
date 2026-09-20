/**
 * dsh-file-tree — host half.
 *
 * A workspace-gated filesystem reader for the file panel: list a directory,
 * preview a file, search by name. The browser half (this package's `./client`
 * export) never names an absolute path; it names the session it is drawn in and
 * the host resolves the workspace from the session store.
 *
 * Beyond the read-only API the host also runs the panel's editor: a code-server
 * (VS Code for the Web) process per workspace, reverse-proxied under this
 * origin so the browser can frame it without a second trusted origin. See
 * `host/code-server.ts` for the process side and `host/proxy.ts` for the proxy.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from 'schemastery';
import { registerRoutes } from './host/routes.js';
import { reapIdle, stopAll } from './host/code-server.js';
import { interceptUpgrades } from './host/proxy.js';
/** Plugin identity, as the loader records it. */
export const name = 'dsh-file-tree';
/** Services this half needs; the panel cannot work without either. */
export const inject = ['webServer', 'sessions'];
export const Config = z.object({
    readLimitBytes: z.number().default(512 * 1024),
    imageLimitBytes: z.number().default(3 * 1024 * 1024),
    listLimit: z.number().default(2000),
    searchLimit: z.number().default(200),
    codeServerEnabled: z.boolean().default(true),
    codeServerPath: z.string().default(''),
    codeServerSearchPaths: z.array(z.string()).default([]),
    // The DSH home is the one directory this deployment already writes to, which
    // makes it the safest default for state a plugin owns.
    codeServerDataDir: z.string().default(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'dsh-file-tree', 'code-server')),
    codeServerArgs: z.array(z.string()).default([]),
    codeServerStartTimeoutSeconds: z.number().default(45),
    codeServerIdleMinutes: z.number().default(120),
});
/** How often idle workbenches are reaped. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Mount the filesystem route and the embedded editor.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
    const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.floor(value)));
    const codeServer = config.codeServerEnabled
        ? {
            binaryPath: config.codeServerPath,
            searchPaths: config.codeServerSearchPaths,
            dataDir: config.codeServerDataDir,
            extraArgs: config.codeServerArgs,
            startTimeoutMs: clamp(config.codeServerStartTimeoutSeconds, 5, 300) * 1000,
            idleTimeoutMs: clamp(config.codeServerIdleMinutes, 0, 24 * 60) * 60_000,
        }
        : undefined;
    const options = {
        readLimitBytes: clamp(config.readLimitBytes, 1024, 8 * 1024 * 1024),
        imageLimitBytes: clamp(config.imageLimitBytes, 0, 16 * 1024 * 1024),
        listLimit: clamp(config.listLimit, 50, 20_000),
        searchLimit: clamp(config.searchLimit, 10, 2000),
        ...(codeServer === undefined ? {} : { codeServer }),
    };
    ctx.effect(() => registerRoutes(ctx, options), 'dsh-file-tree: filesystem routes');
    if (codeServer === undefined)
        return;
    // A workbench's sockets live at prefix paths with a version hash and a query
    // string, which DSH's exact-path upgrade registry cannot express, so the
    // prefix is claimed one level lower.
    ctx.effect(() => interceptUpgrades(ctx), 'dsh-file-tree: code-server socket routing');
    // A workbench is a whole language server plus an extension host; leaving one
    // resident per repository forever is how a laptop runs out of memory.
    ctx.effect(() => {
        if (codeServer.idleTimeoutMs <= 0)
            return () => { };
        const timer = setInterval(() => {
            for (const id of reapIdle(codeServer.idleTimeoutMs)) {
                ctx.logger?.info?.(`dsh-file-tree: stopped idle code-server ${id}`);
            }
        }, REAP_INTERVAL_MS);
        timer.unref?.();
        return () => clearInterval(timer);
    }, 'dsh-file-tree: code-server idle reaper');
    // Unloading the plugin (or shutting the host down) must not leave orphans
    // holding ports and memory.
    ctx.effect(() => () => stopAll(), 'dsh-file-tree: code-server teardown');
}
//# sourceMappingURL=index.js.map