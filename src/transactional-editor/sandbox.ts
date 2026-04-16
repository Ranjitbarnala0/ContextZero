/**
 * ContextZero — Sandbox Execution Engine
 *
 * Process isolation for validation commands. Executes tsc, jest,
 * pytest, and other build/test tools inside a resource-constrained,
 * timeout-enforced subprocess with controlled environment variables
 * and filesystem scope.
 *
 * - Explicit environment sanitization (no secret leakage)
 * - Process group management for reliable cleanup
 * - Resource limits via ulimit (Linux)
 * - Timeout enforcement with SIGKILL escalation
 * - Controlled working directory scope
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from '../logger';

const log = new Logger('sandbox');

/** Result of a sandboxed command execution */
export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    killed: boolean;
    durationMs: number;
}

/** Configuration for a sandbox execution */
export interface SandboxConfig {
    /** Working directory for the command */
    cwd: string;
    /** Maximum execution time in milliseconds */
    timeoutMs: number;
    /** Maximum stdout/stderr capture size in bytes */
    maxOutputBytes: number;
    /** Additional environment variables (merged with sanitized base) */
    env?: Record<string, string>;
    /** Resource limits (Linux ulimit). Defaults to DEFAULT_RESOURCE_LIMITS. */
    resourceLimits?: Partial<SandboxResourceLimits>;
}

/** Resource limits for sandboxed processes */
export interface SandboxResourceLimits {
    /** Maximum virtual memory in MB (ulimit -v) */
    maxMemoryMb: number;
    /** Maximum CPU time in seconds (ulimit -t) */
    maxCpuSeconds: number;
    /** Maximum number of child processes (ulimit -u) */
    maxProcesses: number;
    /** Maximum file size in MB (ulimit -f) */
    maxFileSizeMb: number;
    /** Maximum open file descriptors (ulimit -n) */
    maxOpenFiles: number;
}

/** Default resource limits — generous enough for builds, tight enough to prevent abuse */
const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
    maxMemoryMb: 2048,      // 2GB virtual memory
    maxCpuSeconds: 300,      // 5 minutes CPU time
    maxProcesses: 64,        // max 64 child processes
    maxFileSizeMb: 100,      // max 100MB output files
    maxOpenFiles: 256,       // max 256 open FDs
};

/** Default sandbox configuration */
const DEFAULT_CONFIG: Omit<SandboxConfig, 'cwd'> = {
    timeoutMs: 120_000,        // 2 minutes
    maxOutputBytes: 1_048_576, // 1MB
};

/**
 * Detect whether `unshare` is available on this system.
 * Cached after first probe to avoid repeated execSync calls.
 * When available, we use it to give sandboxed processes their own PID
 * namespace so /proc/1 is the sandbox itself — not the parent — which
 * prevents the child from reading /proc/<parent_pid>/environ to steal
 * API keys, DB credentials, or other secrets from the host environment.
 */
let _unshareAvailable: boolean | null = null;
function isUnshareAvailable(): boolean {
    if (_unshareAvailable !== null) return _unshareAvailable;
    try {
        execSync('which unshare', { stdio: 'ignore', timeout: 3_000 });
        _unshareAvailable = true;
    } catch {
        _unshareAvailable = false;
        log.warn(
            'unshare(1) not found — sandbox processes will NOT run in a PID namespace. ' +
            '/proc of the parent process may be readable by sandboxed commands. ' +
            'Install util-linux to enable PID namespace isolation.'
        );
    }
    return _unshareAvailable;
}

/**
 * Build a sanitized environment for subprocess execution.
 * Strips all sensitive variables, preserves only what's needed for builds.
 * Runtime secrets, credentials, and production tokens are never exposed.
 */
function getSandboxHome(cwd: string): string {
    const digest = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'contextzero-sandbox', digest);
}

export function buildSanitizedEnv(cwd: string, extra?: Record<string, string>): Record<string, string> {
    const sandboxHome = getSandboxHome(cwd);
    const npmCacheDir = path.join(sandboxHome, '.npm');
    fs.mkdirSync(npmCacheDir, { recursive: true });

    const safe: Record<string, string> = {};

    // Only forward the minimum host environment needed to execute local tooling.
    const ALLOWED_VARS = [
        'PATH',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TERM',
        'NODE_ENV',
    ];

    for (const key of ALLOWED_VARS) {
        const val = process.env[key];
        if (val !== undefined) {
            safe[key] = val;
        }
    }

    // Use an isolated home/cache so sandboxed tools do not inherit host paths or secrets.
    safe['HOME'] = sandboxHome;
    safe['npm_config_cache'] = npmCacheDir;
    safe['PYTHONNOUSERSITE'] = '1';
    safe['TMPDIR'] = process.env['TMPDIR'] || os.tmpdir();
    safe['TMP'] = process.env['TMP'] || safe['TMPDIR'];
    safe['TEMP'] = process.env['TEMP'] || safe['TMPDIR'];

    // Force non-interactive mode
    safe['CI'] = 'true';
    safe['FORCE_COLOR'] = '0';
    safe['NO_COLOR'] = '1';
    safe['npm_config_update_notifier'] = 'false';

    // Merge extra vars (caller-specified overrides)
    if (extra) {
        Object.assign(safe, extra);
    }

    // Strip dangerous environment variables that could be injected via `extra`
    // to hijack the sandbox process (e.g. LD_PRELOAD to load attacker libraries).
    const DANGEROUS_ENV_VARS = new Set([
        'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG',
        'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
        'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
        'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
        'BASH_ENV', 'ENV', 'CDPATH', 'GLOBIGNORE',
        'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT',
    ]);
    for (const dangerous of DANGEROUS_ENV_VARS) {
        delete safe[dangerous];
    }

    return safe;
}

/**
 * Execute a command inside the sandbox with resource constraints.
 *
 * Uses spawn (not exec/execSync) for:
 * - Non-blocking execution with streaming output capture
 * - Process group management (detached + negative PID kill)
 * - Output truncation to prevent memory exhaustion
 * - Graceful SIGTERM -> hard SIGKILL escalation
 */
export async function sandboxExec(
    command: string,
    args: string[],
    config: SandboxConfig
): Promise<SandboxResult> {
    if (args.some(a => a.includes('\0'))) {
        throw new Error('Null bytes are not permitted in command arguments');
    }

    const timer = log.startTimer('sandboxExec', {
        command,
        args: args.slice(0, 3),
        cwd: config.cwd,
        timeoutMs: config.timeoutMs,
    });

    const startTime = Date.now();
    const effectiveTimeout = config.timeoutMs || DEFAULT_CONFIG.timeoutMs;
    const maxOutput = config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes;

    return new Promise<SandboxResult>((resolve) => {
        // Verify working directory exists and is within expected scope
        const resolvedCwd = path.resolve(config.cwd);
        if (!fs.existsSync(resolvedCwd)) {
            resolve({
                exitCode: -1,
                stdout: '',
                stderr: `Sandbox working directory does not exist: ${resolvedCwd}`,
                timedOut: false,
                killed: false,
                durationMs: Date.now() - startTime,
            });
            return;
        }
        const env = buildSanitizedEnv(resolvedCwd, config.env);

        let stdoutBuf = '';
        let stderrBuf = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let killed = false;
        let finished = false;
        let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

        // On Linux, wrap command with ulimit for resource constraints.
        // This is the native equivalent of container resource limits —
        // enforces memory, CPU, process count, and file size ceilings.
        const limits = { ...DEFAULT_RESOURCE_LIMITS, ...config.resourceLimits };

        // Validate all resource limits are positive integers to prevent shell injection.
        // If any limit is not a safe integer, fall back to the default.
        for (const key of Object.keys(DEFAULT_RESOURCE_LIMITS) as Array<keyof SandboxResourceLimits>) {
            if (!Number.isInteger(limits[key]) || limits[key] <= 0) {
                limits[key] = DEFAULT_RESOURCE_LIMITS[key];
            }
        }

        let spawnCommand = command;
        let spawnArgs = args;

        if (process.platform === 'linux') {
            // Each ulimit is wrapped in a subshell that silently ignores failures.
            // Some systems restrict certain ulimit flags (e.g., -u requires
            // appropriate privileges, -v may not be supported on all kernels).
            // Using `(ulimit ... 2>/dev/null || true)` ensures the sandbox
            // starts even when specific limits can't be applied.
            const safeUlimit = (flag: string, value: number) =>
                `(ulimit ${flag} ${Math.floor(value)} 2>/dev/null || true)`;
            const ulimitPrefix = [
                safeUlimit('-v', limits.maxMemoryMb * 1024),    // virtual memory in KB
                safeUlimit('-t', limits.maxCpuSeconds),          // CPU time in seconds
                safeUlimit('-u', limits.maxProcesses),           // max user processes
                safeUlimit('-f', limits.maxFileSizeMb * 1024),   // file size in KB
                safeUlimit('-n', limits.maxOpenFiles),           // open file descriptors
            ].join(' && ');

            // Wrap: sh -c "ulimit ... && exec <original command>"
            // exec replaces the shell so signals reach the actual process
            const escapeShell = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
            const escapedArgs = args.map(a => escapeShell(a)).join(' ');
            const escapedCommand = escapeShell(command);

            // If unshare is available, wrap in a PID namespace so the child
            // sees itself as PID 1 and cannot read /proc/<parent_pid>/environ.
            // -r  = map current user to root inside namespace (avoids EPERM)
            // --pid --fork = new PID namespace, fork so child becomes PID 1
            // --mount-proc = mount a private /proc showing only the namespace
            // Falls back to bare execution if unshare fails at runtime.
            const innerCmd = `${ulimitPrefix} && exec ${escapedCommand} ${escapedArgs}`;
            if (isUnshareAvailable()) {
                spawnCommand = '/bin/sh';
                spawnArgs = [
                    '-c',
                    `unshare -r --pid --fork --mount-proc /bin/sh -c ${escapeShell(innerCmd)} 2>/dev/null || ` +
                    `/bin/sh -c ${escapeShell(innerCmd)}`,
                ];
            } else {
                spawnCommand = '/bin/sh';
                spawnArgs = ['-c', innerCmd];
            }
        }

        const child = spawn(spawnCommand, spawnArgs, {
            cwd: resolvedCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Use process group for clean kill of child trees
            detached: process.platform !== 'win32',
            // Don't inherit any file descriptors
            windowsHide: true,
        });

        // Capture stdout with size limit
        child.stdout.on('data', (chunk: Buffer) => {
            if (!stdoutTruncated) {
                stdoutBuf += chunk.toString('utf-8');
                if (stdoutBuf.length > maxOutput) {
                    stdoutBuf = stdoutBuf.substring(0, maxOutput) + '\n... [output truncated at 1MB]';
                    stdoutTruncated = true;
                }
            }
        });

        // Capture stderr with size limit
        child.stderr.on('data', (chunk: Buffer) => {
            if (!stderrTruncated) {
                stderrBuf += chunk.toString('utf-8');
                if (stderrBuf.length > maxOutput) {
                    stderrBuf = stderrBuf.substring(0, maxOutput) + '\n... [output truncated at 1MB]';
                    stderrTruncated = true;
                }
            }
        });

        // Close stdin immediately — sandbox commands should not read from stdin
        child.stdin.end();

        // Timeout handler with escalation
        const timeoutHandle = setTimeout(() => {
            if (finished) return;
            timedOut = true;
            killed = true;

            log.warn('Sandbox execution timed out, sending SIGTERM', {
                command,
                pid: child.pid,
                timeoutMs: effectiveTimeout,
            });

            // Try graceful kill first (SIGTERM to process group)
            try {
                if (child.pid && process.platform !== 'win32') {
                    process.kill(-child.pid, 'SIGTERM');
                } else {
                    child.kill('SIGTERM');
                }
            } catch (err) {
                log.debug('SIGTERM send failed — process may have already exited', {
                    pid: child.pid,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            // Escalate to SIGKILL after grace period if still alive
            const SIGKILL_ESCALATION_MS = 5_000;
            sigkillTimer = setTimeout(() => {
                try {
                    if (child.pid && process.platform !== 'win32') {
                        process.kill(-child.pid, 'SIGKILL');
                    } else {
                        child.kill('SIGKILL');
                    }
                } catch (err) {
                    log.debug('SIGKILL send failed — process already terminated', {
                        pid: child.pid,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }, SIGKILL_ESCALATION_MS);
        }, effectiveTimeout);

        child.on('close', (code: number | null, signal: string | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);
            if (sigkillTimer) clearTimeout(sigkillTimer);

            const durationMs = Date.now() - startTime;
            const exitCode = code ?? (signal ? 128 : -1);

            timer({
                exitCode,
                timedOut,
                killed,
                stdout_bytes: stdoutBuf.length,
                stderr_bytes: stderrBuf.length,
            });

            resolve({
                exitCode,
                stdout: stdoutBuf,
                stderr: stderrBuf,
                timedOut,
                killed,
                durationMs,
            });
        });

        child.on('error', (err: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);

            log.error('Sandbox spawn error', err, { command });
            resolve({
                exitCode: -1,
                stdout: stdoutBuf,
                stderr: `Spawn error: ${err.message}`,
                timedOut: false,
                killed: false,
                durationMs: Date.now() - startTime,
            });
        });
    });
}

/**
 * Execute TypeScript type checking inside the sandbox.
 */
export async function sandboxTypeCheck(
    projectPath: string,
    tsconfigPath?: string
): Promise<SandboxResult> {
    const effectiveTsconfig = tsconfigPath || path.join(projectPath, 'tsconfig.json');
    const TS_TYPE_CHECK_TIMEOUT_MS = 60_000; // 1 minute
    const TS_TYPE_CHECK_MAX_OUTPUT = 512_000; // 500KB
    return sandboxExec('npx', ['tsc', '--noEmit', '--project', effectiveTsconfig], {
        cwd: projectPath,
        timeoutMs: TS_TYPE_CHECK_TIMEOUT_MS,
        maxOutputBytes: TS_TYPE_CHECK_MAX_OUTPUT,
    });
}

/**
 * Execute test runner inside the sandbox.
 */
export async function sandboxRunTests(
    projectPath: string,
    testPaths: string[],
    framework: 'jest' | 'mocha' | 'pytest' = 'jest'
): Promise<SandboxResult> {
    let command: string;
    let args: string[];

    switch (framework) {
        case 'jest':
            command = 'npx';
            args = ['jest', '--passWithNoTests', '--no-coverage', '--forceExit', ...testPaths];
            break;
        case 'mocha':
            command = 'npx';
            args = ['mocha', '--timeout', '30000', ...testPaths];
            break;
        case 'pytest':
            command = 'python3';
            args = ['-m', 'pytest', '-x', '--tb=short', ...testPaths];
            break;
    }

    return sandboxExec(command, args, {
        cwd: projectPath,
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
    });
}

/**
 * Execute a Python syntax check inside the sandbox.
 */
export async function sandboxPythonCheck(
    projectPath: string,
    filePaths: string[]
): Promise<SandboxResult> {
    return sandboxExec('python3', ['-m', 'py_compile', ...filePaths], {
        cwd: projectPath,
        timeoutMs: 30_000,
        maxOutputBytes: 256_000,
    });
}
