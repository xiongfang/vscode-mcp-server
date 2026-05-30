import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { TextDecoder } from 'util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getWorkspaceRoot, resolveWorkspacePath, toolResult, ToolFormat } from './tool-utils';

interface ProcessSession {
    id: string;
    command: string;
    cwd: string;
    process: ChildProcessWithoutNullStreams;
    output: string[];
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    startedAt: number;
    lastReadIndex: number;
    flushOutput?: () => void;
}

const sessions = new Map<string, ProcessSession>();
let nextSessionId = 1;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_OUTPUT = 20000;
const MAX_BUFFERED_OUTPUT_BYTES = 64 * 1024;

class WindowsOutputDecoder {
    private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    private readonly gb18030Decoder = new TextDecoder('gb18030');
    private pending = Buffer.alloc(0);

    write(chunk: Buffer): string {
        this.pending = Buffer.concat([this.pending, chunk]);
        const output: string[] = [];
        let lineEnd: number;

        while ((lineEnd = this.pending.indexOf(0x0a)) !== -1) {
            output.push(this.decode(this.pending.subarray(0, lineEnd + 1)));
            this.pending = this.pending.subarray(lineEnd + 1);
        }

        // Keep normal partial lines intact so split multibyte characters are not
        // misdetected. Bound the buffer for commands that stream without newlines.
        if (this.pending.length > MAX_BUFFERED_OUTPUT_BYTES) {
            output.push(this.decode(this.pending));
            this.pending = Buffer.alloc(0);
        }

        return output.join('');
    }

    end(): string {
        const output = this.decode(this.pending);
        this.pending = Buffer.alloc(0);
        return output;
    }

    private decode(chunk: Buffer): string {
        if (chunk.length === 0) {
            return '';
        }

        try {
            return this.utf8Decoder.decode(chunk);
        } catch {
            return this.gb18030Decoder.decode(chunk);
        }
    }
}

function trimOutput(text: string, maxCharacters: number): { text: string; truncated: boolean } {
    if (text.length <= maxCharacters) {
        return { text, truncated: false };
    }
    return {
        text: text.slice(text.length - maxCharacters),
        truncated: true
    };
}

function createSession(command: string, cwd: string, timeout?: number): ProcessSession {
    const id = String(nextSessionId++);

    // ── Windows 编码修复 ──
    // Windows 的 cmd.exe 默认输出使用系统活动代码页（中文系统=GBK/CP936），
    // 但 Node.js 的 String(chunk) 默认以 UTF-8 解码 Buffer，导致中文字符乱码。
    // 解决方案：在 Windows 上强制切换 cmd 代码页为 UTF-8 (65001)，
    // 并优先使用 TextDecoder 解码 Buffer，避免 String() 的 UTF-8 默认行为。
    const cmd = process.platform === 'win32'
        ? `chcp 65001 >nul && ${command}`
        : command;

    const child = spawn(cmd, {
        cwd,
        shell: true,
        env: process.env
    });

    const session: ProcessSession = {
        id,
        command,
        cwd,
        process: child,
        output: [],
        startedAt: Date.now(),
        lastReadIndex: 0
    };

    // cmd.exe diagnostics can still use CP936 even after chcp 65001. Decode
    // each Windows stream adaptively so UTF-8 tools and native errors coexist.
    const stdoutDecoder = process.platform === 'win32' ? new WindowsOutputDecoder() : undefined;
    const stderrDecoder = process.platform === 'win32' ? new WindowsOutputDecoder() : undefined;
    const appendOutput = (chunk: string) => {
        if (chunk) {
            session.output.push(chunk);
        }
    };
    session.flushOutput = () => {
        appendOutput(stdoutDecoder?.end() ?? '');
        appendOutput(stderrDecoder?.end() ?? '');
    };

    child.stdout.on('data', chunk => appendOutput(stdoutDecoder ? stdoutDecoder.write(chunk) : String(chunk)));
    child.stderr.on('data', chunk => appendOutput(stderrDecoder ? stderrDecoder.write(chunk) : String(chunk)));
    child.stdout.on('end', () => appendOutput(stdoutDecoder?.end() ?? ''));
    child.stderr.on('end', () => appendOutput(stderrDecoder?.end() ?? ''));
    child.on('close', (code, signal) => {
        session.exitCode = code;
        session.signal = signal;
    });

    if (timeout && timeout > 0) {
        setTimeout(() => {
            if (session.exitCode === undefined) {
                child.kill();
            }
        }, timeout);
    }

    sessions.set(id, session);
    return session;
}

async function waitForSession(session: ProcessSession, timeout: number): Promise<void> {
    if (session.exitCode !== undefined) {
        return;
    }

    await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeout);
        session.process.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function getSessionOutput(session: ProcessSession, sinceLastRead: boolean, maxCharacters: number) {
    session.flushOutput?.();
    const chunks = sinceLastRead ? session.output.slice(session.lastReadIndex) : session.output;
    if (sinceLastRead) {
        session.lastReadIndex = session.output.length;
    }
    return trimOutput(chunks.join(''), maxCharacters);
}

export function registerShellTools(server: McpServer): void {
    server.tool(
        'execute_shell_command',
        `Executes a shell command. Short commands return a completed result; long-running commands return a sessionId for polling or stdin writes.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Working directory relative to the workspace root'),
            timeout: z.number().optional().default(DEFAULT_TIMEOUT_MS).describe('Milliseconds to wait before returning a session for ongoing commands'),
            maxOutputCharacters: z.number().optional().default(DEFAULT_MAX_OUTPUT).describe('Maximum output characters to return'),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ command, cwd = '.', timeout = DEFAULT_TIMEOUT_MS, maxOutputCharacters = DEFAULT_MAX_OUTPUT, format = 'text' }): Promise<CallToolResult> => {
            const start = Date.now();
            const workdir = cwd === '.' ? getWorkspaceRoot() : resolveWorkspacePath(cwd).fsPath;
            const session = createSession(command, workdir, 0);
            await waitForSession(session, timeout);

            const output = getSessionOutput(session, false, maxOutputCharacters);
            const running = session.exitCode === undefined;
            const data = {
                command,
                cwd: workdir,
                sessionId: running ? session.id : undefined,
                running,
                exitCode: session.exitCode,
                signal: session.signal,
                output: output.text,
                truncated: output.truncated
            };

            if (!running) {
                sessions.delete(session.id);
            }

            return toolResult({
                ok: !running && session.exitCode === 0,
                summary: running
                    ? `Command is still running in session ${session.id}`
                    : `Command exited with code ${session.exitCode}`,
                data,
                durationMs: Date.now() - start
            }, format as ToolFormat, `$ ${command}\n${output.truncated ? '[output truncated]\n' : ''}${output.text}${running ? `\n[session_id: ${session.id}]` : `\n[exit_code: ${session.exitCode}]`}`);
        }
    );

    server.tool(
        'read_process_output',
        `Reads output from a running shell session.`,
        {
            sessionId: z.string().describe('Session id returned by execute_shell_command or start_process'),
            sinceLastRead: z.boolean().optional().default(true).describe('Only return output not previously read'),
            maxOutputCharacters: z.number().optional().default(DEFAULT_MAX_OUTPUT),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ sessionId, sinceLastRead = true, maxOutputCharacters = DEFAULT_MAX_OUTPUT, format = 'text' }): Promise<CallToolResult> => {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`Unknown process session: ${sessionId}`);
            }

            const output = getSessionOutput(session, sinceLastRead, maxOutputCharacters);
            const running = session.exitCode === undefined;
            const data = {
                sessionId,
                running,
                exitCode: session.exitCode,
                signal: session.signal,
                output: output.text,
                truncated: output.truncated
            };

            if (!running && sinceLastRead) {
                sessions.delete(sessionId);
            }

            return toolResult({
                ok: true,
                summary: running ? `Session ${sessionId} is still running` : `Session ${sessionId} exited with code ${session.exitCode}`,
                data
            }, format as ToolFormat, `${output.truncated ? '[output truncated]\n' : ''}${output.text}${running ? '' : `\n[exit_code: ${session.exitCode}]`}`);
        }
    );

    server.tool(
        'write_process_stdin',
        `Writes text to a running shell session stdin.`,
        {
            sessionId: z.string(),
            chars: z.string().describe('Characters to write to stdin'),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ sessionId, chars, format = 'text' }): Promise<CallToolResult> => {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`Unknown process session: ${sessionId}`);
            }
            session.process.stdin.write(chars);
            return toolResult({
                ok: true,
                summary: `Wrote ${chars.length} characters to session ${sessionId}`,
                data: { sessionId, written: chars.length }
            }, format as ToolFormat);
        }
    );

    server.tool(
        'stop_process',
        `Stops a running shell session.`,
        {
            sessionId: z.string(),
            signal: z.string().optional().default('SIGTERM'),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ sessionId, signal = 'SIGTERM', format = 'text' }): Promise<CallToolResult> => {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`Unknown process session: ${sessionId}`);
            }
            session.process.kill(signal as NodeJS.Signals);
            return toolResult({
                ok: true,
                summary: `Sent ${signal} to session ${sessionId}`,
                data: { sessionId, signal }
            }, format as ToolFormat);
        }
    );

    server.tool(
        'list_processes',
        `Lists active shell sessions.`,
        {
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ format = 'text' }): Promise<CallToolResult> => {
            const data = Array.from(sessions.values()).map(session => ({
                sessionId: session.id,
                command: session.command,
                cwd: session.cwd,
                running: session.exitCode === undefined,
                exitCode: session.exitCode,
                startedAt: new Date(session.startedAt).toISOString()
            }));
            return toolResult({
                ok: true,
                summary: `${data.length} process session(s)`,
                data
            }, format as ToolFormat, JSON.stringify(data, null, 2));
        }
    );
}
