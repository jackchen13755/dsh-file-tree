/**
 * dsh-file-tree — host half.
 *
 * A workspace-gated filesystem reader for the file panel: list a directory,
 * preview a file, search by name. The browser half (this package's `./client`
 * export) never names an absolute path; it names the session it is drawn in and
 * the host resolves the workspace from the session store.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { registerRoutes, type RouteOptions } from './host/routes.js'

/** Plugin identity, as the loader records it. */
export const name = 'dsh-file-tree'

/** Services this half needs; the panel cannot work without either. */
export const inject = ['webServer', 'sessions']

/** Operator-facing knobs, set on the bundle row in the profile. */
export interface Config {
  /** Byte ceiling for a text preview. */
  readLimitBytes: number
  /** Byte ceiling for an inline image preview. */
  imageLimitBytes: number
  /** Maximum entries returned for one directory. */
  listLimit: number
  /** Maximum hits returned by one search. */
  searchLimit: number
}

export const Config: z<Config> = z.object({
  readLimitBytes: z.number().default(512 * 1024),
  imageLimitBytes: z.number().default(3 * 1024 * 1024),
  listLimit: z.number().default(2000),
  searchLimit: z.number().default(200),
})

/**
 * Mount the filesystem route.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.floor(value)))
  const options: RouteOptions = {
    readLimitBytes: clamp(config.readLimitBytes, 1024, 8 * 1024 * 1024),
    imageLimitBytes: clamp(config.imageLimitBytes, 0, 16 * 1024 * 1024),
    listLimit: clamp(config.listLimit, 50, 20_000),
    searchLimit: clamp(config.searchLimit, 10, 2000),
  }
  ctx.effect(() => registerRoutes(ctx, options), 'dsh-file-tree: filesystem routes')
}
