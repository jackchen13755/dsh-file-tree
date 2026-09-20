import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
/** Plugin identity, as the loader records it. */
export declare const name = "dsh-file-tree";
/** Services this half needs; the panel cannot work without either. */
export declare const inject: string[];
/** Operator-facing knobs, set on the bundle row in the profile. */
export interface Config {
    /** Byte ceiling for a text preview. */
    readLimitBytes: number;
    /** Byte ceiling for an inline image preview. */
    imageLimitBytes: number;
    /** Maximum entries returned for one directory. */
    listLimit: number;
    /** Maximum hits returned by one search. */
    searchLimit: number;
    /** Serve the embedded code-server editor (the panel's "编辑器" view). */
    codeServerEnabled: boolean;
    /** Explicit code-server launcher, `bin/` directory, or installation root. */
    codeServerPath: string;
    /** Extra directories to search for an installation. */
    codeServerSearchPaths: string[];
    /** Where workbench user-data and extensions live; one subdirectory per workspace. */
    codeServerDataDir: string;
    /** Extra CLI arguments appended to every code-server launch. */
    codeServerArgs: string[];
    /** Seconds to wait for a workbench to start listening. */
    codeServerStartTimeoutSeconds: number;
    /** Minutes of inactivity after which a workbench is stopped; 0 disables reaping. */
    codeServerIdleMinutes: number;
}
export declare const Config: z<Config>;
/**
 * Mount the filesystem route and the embedded editor.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
