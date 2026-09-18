/** One alias rule: a specifier prefix mapped to workspace-relative targets. */
export interface AliasRule {
    /** Specifier prefix, without the trailing `*`. */
    readonly prefix: string;
    /** Whether the rule matches only that exact specifier. */
    readonly exact: boolean;
    /** Candidate targets, workspace-relative (`*` is substituted when present). */
    readonly targets: readonly string[];
    /** Where the rule came from, for the jump's message. */
    readonly source: string;
}
/** Alias rules plus extra module roots a workspace resolves bare specifiers from. */
export interface AliasTable {
    readonly rules: readonly AliasRule[];
    /** Workspace-relative directories tried before `node_modules` (e.g. `src`). */
    readonly roots: readonly string[];
}
/**
 * Build (or reuse) the alias table of one workspace.
 * @param workspace - the session's workspace root.
 */
export declare function aliasTable(workspace: string): Promise<AliasTable>;
/**
 * Resolve a specifier through the alias table.
 * @param specifier - the raw specifier from the source.
 * @param table - the workspace's alias table.
 * @returns workspace-relative base candidates, most specific rule first.
 */
export declare function aliasCandidates(specifier: string, table: AliasTable): Array<{
    base: string;
    source: string;
}>;
/** Directory names read at the workspace root, for a quick "does this top-level dir exist" probe. */
export declare function topLevelDirectories(workspace: string): Promise<Set<string>>;
