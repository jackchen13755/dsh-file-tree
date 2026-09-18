/** One row of a directory listing. */
export interface EntryInfo {
    /** Basename. */
    readonly name: string;
    /** Path relative to the workspace root, `/`-separated. */
    readonly path: string;
    readonly dir: boolean;
    readonly size: number;
    /** Epoch milliseconds of the last modification. */
    readonly mtime: number;
}
/**
 * Resolve a caller-supplied relative path inside the workspace.
 * @param workspace - the session's working directory (the fence).
 * @param relative - `/`-separated path relative to it; empty means the root.
 * @returns the canonical absolute path, or null when it escapes or does not exist.
 */
export declare function resolvePath(workspace: string, relative: string): string | null;
/**
 * List one directory.
 * @param workspace - workspace root.
 * @param relative - directory path relative to the root.
 * @param limit - maximum entries returned (directories first, then files, both by name).
 */
export declare function listDirectory(workspace: string, relative: string, limit: number): Promise<{
    path: string;
    entries: EntryInfo[];
    truncated: boolean;
} | null>;
/** Result of reading a file for preview. */
export interface FilePreview {
    readonly path: string;
    readonly size: number;
    readonly kind: 'text' | 'image' | 'binary' | 'too-large';
    /** Text content for `text`; a `data:` URL for `image`. */
    readonly content?: string;
    readonly truncated?: boolean;
    readonly mime?: string;
}
/**
 * Read a file for preview: text (capped), image (base64 data URL), or a refusal.
 * @param workspace - workspace root.
 * @param relative - file path relative to the root.
 * @param textLimit - byte ceiling for text previews.
 * @param imageLimit - byte ceiling for image previews.
 */
export declare function readPreview(workspace: string, relative: string, textLimit: number, imageLimit: number): Promise<FilePreview | null>;
/**
 * Bounded recursive name search: breadth-first, skipping noise directories.
 * @param workspace - workspace root.
 * @param query - case-insensitive substring matched against the basename.
 * @param limit - maximum hits.
 * @param maxDepth - directory depth ceiling.
 */
export declare function searchFiles(workspace: string, query: string, limit: number, maxDepth: number): Promise<EntryInfo[]>;
