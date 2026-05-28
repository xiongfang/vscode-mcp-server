import { execFile } from 'child_process';
import { promisify } from 'util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getWorkspaceRoot, toolResult, ToolFormat } from './tool-utils';

const execFileAsync = promisify(execFile);

async function git(args: string[], timeout: number = 10000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const result = await execFileAsync('git', args, {
            cwd: getWorkspaceRoot(),
            timeout,
            maxBuffer: 10 * 1024 * 1024
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error: any) {
        return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message,
            exitCode: typeof error.code === 'number' ? error.code : 1
        };
    }
}

function textFor(command: string, result: { stdout: string; stderr: string; exitCode: number }): string {
    return `$ ${command}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}\n[exit_code: ${result.exitCode}]`;
}

export function registerGitTools(server: McpServer): void {
    server.tool(
        'git_status',
        `Returns git status for the workspace.`,
        {
            porcelain: z.boolean().optional().default(false),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ porcelain = false, format = 'text' }): Promise<CallToolResult> => {
            const args = porcelain ? ['status', '--porcelain=v1', '-b'] : ['status', '--short', '--branch'];
            const result = await git(args);
            return toolResult({
                ok: result.exitCode === 0,
                summary: result.exitCode === 0 ? 'Git status collected' : 'Git status failed',
                data: { command: `git ${args.join(' ')}`, ...result }
            }, format as ToolFormat, textFor(`git ${args.join(' ')}`, result));
        }
    );

    server.tool(
        'git_diff',
        `Returns git diff for the workspace or a specific path.`,
        {
            path: z.string().optional().default(''),
            staged: z.boolean().optional().default(false),
            maxOutputCharacters: z.number().optional().default(50000),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ path = '', staged = false, maxOutputCharacters = 50000, format = 'text' }): Promise<CallToolResult> => {
            const args = ['diff'];
            if (staged) {
                args.push('--staged');
            }
            if (path) {
                args.push('--', path);
            }
            const result = await git(args);
            const truncated = result.stdout.length > maxOutputCharacters;
            const stdout = truncated ? result.stdout.slice(result.stdout.length - maxOutputCharacters) : result.stdout;
            return toolResult({
                ok: result.exitCode === 0,
                summary: result.exitCode === 0 ? 'Git diff collected' : 'Git diff failed',
                data: { command: `git ${args.join(' ')}`, ...result, stdout, truncated }
            }, format as ToolFormat, textFor(`git ${args.join(' ')}`, { ...result, stdout }));
        }
    );

    server.tool(
        'git_log',
        `Returns recent git commits.`,
        {
            maxCount: z.number().optional().default(10),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ maxCount = 10, format = 'text' }): Promise<CallToolResult> => {
            const args = ['log', `-${maxCount}`, '--oneline', '--decorate'];
            const result = await git(args);
            return toolResult({
                ok: result.exitCode === 0,
                summary: result.exitCode === 0 ? 'Git log collected' : 'Git log failed',
                data: { command: `git ${args.join(' ')}`, ...result }
            }, format as ToolFormat, textFor(`git ${args.join(' ')}`, result));
        }
    );

    server.tool(
        'git_show',
        `Returns git show output for a revision.`,
        {
            revision: z.string().optional().default('HEAD'),
            maxOutputCharacters: z.number().optional().default(50000),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ revision = 'HEAD', maxOutputCharacters = 50000, format = 'text' }): Promise<CallToolResult> => {
            const args = ['show', '--stat', '--patch', revision];
            const result = await git(args);
            const truncated = result.stdout.length > maxOutputCharacters;
            const stdout = truncated ? result.stdout.slice(result.stdout.length - maxOutputCharacters) : result.stdout;
            return toolResult({
                ok: result.exitCode === 0,
                summary: result.exitCode === 0 ? `Git show collected for ${revision}` : 'Git show failed',
                data: { command: `git ${args.join(' ')}`, ...result, stdout, truncated }
            }, format as ToolFormat, textFor(`git ${args.join(' ')}`, { ...result, stdout }));
        }
    );

    server.tool(
        'git_add',
        `Stages files with git add.`,
        {
            paths: z.array(z.string()).describe('Paths to stage'),
            format: z.enum(['text', 'json']).optional().default('text')
        },
        async ({ paths, format = 'text' }): Promise<CallToolResult> => {
            const args = ['add', '--', ...paths];
            const result = await git(args);
            return toolResult({
                ok: result.exitCode === 0,
                summary: result.exitCode === 0 ? `Staged ${paths.length} path(s)` : 'git add failed',
                data: { command: `git ${args.join(' ')}`, ...result }
            }, format as ToolFormat, textFor(`git ${args.join(' ')}`, result));
        }
    );
}
