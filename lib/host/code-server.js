/**
 * code-server (VS Code for the Web) process manager for the file panel.
 *
 * The panel's editor is a real code-server workbench, one process per workspace:
 * a process is expensive (hundreds of MB of JS, an extension host, a file
 * watcher), so processes are pooled by canonical workspace path rather than by
 * session — two DSH sessions sitting in the same repository share one workbench
 * and therefore one file watcher and one editor history.
 *
 * Everything a workbench writes lands in a data directory picked here, and the
 * binary is looked up in a fixed order, so a machine with a system-wide
 * code-server uses it while a sandboxed one can point `binaryPath` at a local
 * copy.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs';
import { Socket, createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Route prefix the browser half embeds; the proxy owns everything below it. */
export const CODE_SERVER_PREFIX = '/dsh-file-tree/code-server';
/**
 * The URL the panel should embed for a workspace.
 * @param instanceId - the instance's stable id.
 */
export function instanceUrl(instanceId) {
    return `${CODE_SERVER_PREFIX}/${instanceId}/`;
}
/**
 * Stable id for a workspace: short, URL-safe, and derived from the canonical
 * path so a reloaded page lands on the same process.
 * @param workspace - canonical workspace directory.
 */
export function instanceIdFor(workspace) {
    return createHash('sha256').update(workspace).digest('hex').slice(0, 16);
}
/** Pool keyed by instance id. */
const pool = new Map();
/**
 * Whether a path is a launcher we may execute.
 *
 * Directories are rejected explicitly: a code-server *installation root* is a
 * plausible value for the configured path, and returning the directory itself
 * would hand `spawn` something that fails with no output at all.
 */
function isExecutable(path) {
    try {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
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
export function findBinary(options) {
    const candidates = [];
    const expand = (base) => [
        join(base, 'bin', 'code-server'),
        join(base, 'code-server'),
        base,
    ];
    if (options.binaryPath !== '')
        candidates.push(...expand(options.binaryPath));
    for (const search of options.searchPaths)
        candidates.push(...expand(search));
    // A copy shipped next to the plugin: portable and needs no network at run time.
    candidates.push(...expand(join(pluginRoot(), '.code-server')));
    // Conventional system-wide locations (Homebrew on both prefixes, npm -g, /usr/local).
    candidates.push('/opt/homebrew/bin/code-server', '/usr/local/bin/code-server', join(homedir(), '.local', 'bin', 'code-server'), join(homedir(), '.npm-global', 'bin', 'code-server'));
    for (const candidate of candidates) {
        if (candidate !== '' && isExecutable(candidate))
            return candidate;
    }
    // Finally, whatever `PATH` resolves to.
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (directory === '')
            continue;
        const candidate = join(directory, 'code-server');
        if (isExecutable(candidate))
            return candidate;
    }
    return undefined;
}
/** This package's root, so a locally installed copy can be found. */
function pluginRoot() {
    // src/host/code-server.ts → ../../ during development; lib/host/code-server.js
    // → ../../ from the built tree. Both land on the package directory.
    try {
        return fileURLToPath(new URL('../../', import.meta.url));
    }
    catch {
        return '';
    }
}
/** A port the OS reports as free. */
async function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            probe.close(() => (port === 0 ? reject(new Error('no free port')) : resolve(port)));
        });
    });
}
/** Per-instance data root, so two workbenches never share editor state. */
function dataRoot(options, id) {
    const root = join(options.dataDir, id);
    mkdirSync(join(root, 'user-data'), { recursive: true });
    mkdirSync(join(root, 'extensions'), { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    return root;
}
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
export async function ensureInstance(workspace, options) {
    let canonical = workspace;
    try {
        canonical = realpathSync(workspace);
    }
    catch {
        return {
            id: instanceIdFor(workspace),
            workspace,
            state: 'failed',
            port: 0,
            url: '',
            error: `工作区不存在或不可访问：${workspace}`,
        };
    }
    const id = instanceIdFor(canonical);
    const existing = pool.get(id);
    if (existing !== undefined && !existing.exited) {
        existing.lastUsed = Date.now();
        if (existing.ready !== undefined)
            await existing.ready.catch(() => undefined);
        return existing.instance;
    }
    const binary = findBinary(options);
    if (binary === undefined) {
        return {
            id,
            workspace: canonical,
            state: 'failed',
            port: 0,
            url: '',
            error: '没有找到 code-server。安装方式（任选其一）：\n' +
                '  1) 本插件自带脚本：bash scripts/install-code-server.sh\n' +
                '  2) Homebrew：brew install code-server\n' +
                '  3) 在插件配置里把 codeServer.binaryPath 指向已有的 code-server',
        };
    }
    const record = {
        instance: { id, workspace: canonical, state: 'starting', port: 0, url: instanceUrl(id), note: '正在启动 code-server…' },
        exited: false,
        lastUsed: Date.now(),
        stdout: '',
    };
    pool.set(id, record);
    record.ready = (async () => {
        let port;
        try {
            port = await freePort();
        }
        catch (error) {
            fail(record, `无法分配端口：${message(error)}`);
            return;
        }
        const root = dataRoot(options, id);
        const args = [
            '--bind-addr', `127.0.0.1:${port}`,
            // Loopback only, and the DSH origin is already the trust boundary: a
            // password here would be a second lock on a door that only opens locally.
            '--auth', 'none',
            '--disable-telemetry',
            '--disable-update-check',
            '--disable-workspace-trust',
            '--user-data-dir', join(root, 'user-data'),
            '--extensions-dir', join(root, 'extensions'),
            ...options.extraArgs,
            canonical,
        ];
        let child;
        try {
            child = spawn(binary, args, {
                cwd: canonical,
                env: {
                    ...process.env,
                    XDG_CONFIG_HOME: join(root, 'config'),
                    XDG_DATA_HOME: join(root, 'user-data'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            fail(record, `无法启动 code-server：${message(error)}`);
            return;
        }
        record.child = child;
        record.instance = { ...record.instance, port };
        const note = (text) => {
            record.instance = { ...record.instance, note: text };
        };
        const collect = (chunk) => {
            record.stdout = (record.stdout + chunk.toString('utf8')).slice(-8192);
            // The launcher prints the version before the listener line; both are worth
            // surfacing, and the listener line is the readiness signal.
            const version = /code-server (\d+\.\d+\.\d+)/.exec(record.stdout);
            if (version !== null && record.instance.version === undefined) {
                record.instance = { ...record.instance, version: version[1] };
            }
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('exit', code => {
            record.exited = true;
            if (record.instance.state !== 'ready') {
                fail(record, `code-server 退出（code ${code ?? 'null'}）：\n${tail(record.stdout)}`);
            }
        });
        child.on('error', error => {
            record.exited = true;
            fail(record, `code-server 进程错误：${message(error)}`);
        });
        // Readiness: wait for the listener to actually accept a connection, and stop
        // waiting the moment the process dies — polling a dead child to the full
        // timeout would turn a crash into a 30-second hang for the panel.
        const ready = await waitForListener(port, options.startTimeoutMs, () => record.exited);
        if (record.exited) {
            fail(record, `code-server 启动后立即退出：\n${tail(record.stdout)}`);
            return;
        }
        if (!ready) {
            fail(record, `code-server 启动超时（${Math.round(options.startTimeoutMs / 1000)}s）：\n${tail(record.stdout)}`);
            return;
        }
        record.instance = { ...record.instance, state: 'ready', note: undefined };
    })();
    await record.ready.catch(() => undefined);
    return record.instance;
}
/** A TCP connect probe: cheaper and more truthful than parsing logs. */
async function isListening(port) {
    return new Promise(resolve => {
        const socket = new Socket();
        const done = (value) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(800);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, '127.0.0.1');
    });
}
/**
 * Wait until the workbench accepts a connection, giving up early if it dies.
 * @param port - the port the child was told to bind.
 * @param timeoutMs - overall budget.
 * @param dead - reports whether the child has already exited.
 * @returns whether the port became reachable.
 */
async function waitForListener(port, timeoutMs, dead) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (dead())
            return false;
        if (await isListening(port))
            return true;
        if (Date.now() >= deadline)
            return false;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}
/** Move an instance into its terminal failed state, carrying an explanation. */
function fail(record, error) {
    record.instance = { ...record.instance, state: 'failed', error, note: undefined };
}
/** Last few lines of a child's output, for an error the user can act on. */
function tail(text) {
    return text.trim().split('\n').slice(-6).join('\n');
}
/** Error text without the `Error:` prefix noise. */
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * The instance serving an id, when it is ready to be proxied.
 * @param id - instance id from the URL path.
 */
export function instanceFor(id) {
    const record = pool.get(id);
    if (record === undefined || record.exited)
        return undefined;
    if (record.instance.state !== 'ready' || record.instance.port === 0)
        return undefined;
    record.lastUsed = Date.now();
    return { port: record.instance.port, workspace: record.instance.workspace };
}
/** Every instance in the pool, for the status route. */
export function listInstances() {
    return [...pool.values()].map(record => record.instance);
}
/** The instance an id resolves to, in any state. */
export function viewFor(id) {
    return pool.get(id)?.instance;
}
/**
 * Stop one workbench.
 * @param id - instance id.
 */
export function stopInstance(id) {
    const record = pool.get(id);
    if (record === undefined)
        return false;
    pool.delete(id);
    kill(record);
    return true;
}
/** Stop every workbench this plugin started; called when the plugin unloads. */
export function stopAll() {
    for (const record of pool.values())
        kill(record);
    pool.clear();
}
/** Terminate a child, escalating if it ignores the polite signal. */
function kill(record) {
    const child = record.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null)
        return;
    try {
        child.kill('SIGTERM');
    }
    catch {
        // Already gone.
    }
    const timer = setTimeout(() => {
        try {
            child.kill('SIGKILL');
        }
        catch {
            // Already gone.
        }
    }, 4000);
    // Do not hold the event loop open just to escalate a signal.
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
}
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
export function reapIdle(idleTimeoutMs) {
    if (idleTimeoutMs <= 0)
        return [];
    const cutoff = Date.now() - idleTimeoutMs;
    const stopped = [];
    for (const [id, record] of pool) {
        if (record.lastUsed >= cutoff)
            continue;
        pool.delete(id);
        kill(record);
        stopped.push(id);
    }
    return stopped;
}
//# sourceMappingURL=code-server.js.map