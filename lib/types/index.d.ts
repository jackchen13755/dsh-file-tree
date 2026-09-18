/**
 * dsh-file-tree — host half.
 *
 * A workspace-gated filesystem reader for the file panel: list a directory,
 * preview a file, search by name. The browser half (this package's `./client`
 * export) never names an absolute path; it names the session it is drawn in and
 * the host resolves the workspace from the session store.
 */
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
}
export declare const Config: z<Config>;
/**
 * Mount the filesystem route.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
