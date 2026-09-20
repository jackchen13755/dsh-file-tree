/** Placement of the panel's editor inside the right sidebar. */
export type CodeServerState = 'starting' | 'ready' | 'failed';
/** One running (or failed) workbench. */
export interface CodeServerInstance {
    /** Stable, URL-safe id derived from the workspace — the proxy path segment. */
    readonly id: string;
    /** Canonical workspace directory the workbench was opened on. */
    readonly workspace: string;
    readonly state: CodeServerState;
    /** Loopback port the process listens on; `0` until it is known. */
    readonly port: number;
    /** Browser-facing iframe URL, relative to the DSH origin. */
    readonly url: string;
    /** Why the instance is not usable, when it is not. */
    readonly error?: string;
    /** Human-readable progress note while `state` is `starting`. */
    readonly note?: string;
    /** code-server's own version string once it has reported one. */
    readonly version?: string;
}
/** Operator-facing knobs, resolved from the plugin configuration. */
export interface CodeServerOptions {
    /** Explicit path to a `code-server` launcher (or its `bin/` directory). */
    readonly binaryPath: string;
    /** Extra directories to search for an installation, before the defaults. */
    readonly searchPaths: readonly string[];
    /** Root for user-data and extensions; each workspace gets a subdirectory. */
    readonly dataDir: string;
    /** Extra CLI arguments appended to every launch. */
    readonly extraArgs: readonly string[];
    /** Milliseconds to wait for the HTTP server to announce itself. */
    readonly startTimeoutMs: number;
    /** Reap an idle workbench after this long without a request. */
    readonly idleTimeoutMs: number;
}
/** A lookup that reads the browser-facing prefix, so one place owns the shape. */
export type InstanceView = CodeServerInstance;
/** Route prefix the browser half embeds; the proxy owns everything below it. */
export declare const CODE_SERVER_PREFIX = "/dsh-file-tree/code-server";
/**
 * The URL the panel should embed for a workspace.
 * @param instanceId - the instance's stable id.
 */
export declare function instanceUrl(instanceId: string): string;
/**
 * Stable id for a workspace: short, URL-safe, and derived from the canonical
 * path so a reloaded page lands on the same process.
 * @param workspace - canonical workspace directory.
 */
export declare function instanceIdFor(workspace: string): string;
/**
 * Locate a code-server launcher.
 *
 * Order: the configured path (a launcher, a `bin/` directory, or an installation
 * root), then each configured search directory, then a copy installed inside
 * this package (`<plugin>/.code-server/`, see `scripts/install-code-server.sh`),
 * and finally `PATH`.
 *
 * @param options - resolved plugin configuration.
 * @returns the launcher's absolute path, or undefined when nothing is installed.
 */
export declare function findBinary(options: CodeServerOptions): string | undefined;
/**
 * Start (or reuse) the workbench for a workspace.
 *
 * Concurrent callers share one launch: the second call sees `starting` and
 * awaits the first call's readiness promise instead of spawning again.
 *
 * @param workspace - the session's working directory (canonicalised here).
 * @param options - resolved plugin configuration.
 * @returns the instance view, in whatever state it reached.
 */
export declare function ensureInstance(workspace: string, options: CodeServerOptions): Promise<CodeServerInstance>;
/**
 * The instance serving an id, when it is ready to be proxied.
 * @param id - instance id from the URL path.
 */
export declare function instanceFor(id: string): {
    port: number;
    workspace: string;
} | undefined;
/** Every instance in the pool, for the status route. */
export declare function listInstances(): readonly CodeServerInstance[];
/** The instance an id resolves to, in any state. */
export declare function viewFor(id: string): CodeServerInstance | undefined;
/**
 * Stop one workbench.
 * @param id - instance id.
 */
export declare function stopInstance(id: string): boolean;
/** Stop every workbench this plugin started; called when the plugin unloads. */
export declare function stopAll(): void;
/**
 * Reap workbenches nobody has touched for a while.
 *
 * A workbench costs real memory (extension host + watcher), and a user who
 * opened four repositories an hour ago does not need four of them resident. The
 * panel starts a fresh one on the next request, so this only costs a restart.
 *
 * @param idleTimeoutMs - idle budget; `0` disables reaping.
 * @returns the ids that were stopped.
 */
export declare function reapIdle(idleTimeoutMs: number): readonly string[];
