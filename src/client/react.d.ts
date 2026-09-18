/**
 * Minimal ambient React surface for the browser half.
 *
 * The client bundle marks `react` external and the profile's module loader
 * supplies the real implementation at runtime, so the build only needs the
 * handful of names this plugin calls. Declaring them here keeps the build
 * dependency-free: no `npm install` is required to compile this package.
 */
declare module 'react' {
  /** Anything renderable; the panel never inspects it. */
  export type ReactNode = unknown

  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactNode

  export function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void]

  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void

  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T

  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T

  export function useRef<T>(initial: T): { current: T }
}

/**
 * The module loader hands each client bundle a `require` that resolves the
 * product's own packages (react, ui-primitives, …). It is in scope for every
 * module of this bundle because the bundler nests them in that factory.
 */
declare const require: (id: string) => unknown
