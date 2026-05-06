import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// Unified Diff 格式解析与应用
// 抄自 Continue (github.com/continuedev/continue)
// 核心文件: core/edit/lazy/unifiedDiffApply.ts
// ============================================================

export interface DiffLine {
  type: 'same' | 'new' | 'old';
  line: string;
}

interface Hunk {
  lines: string[];
}

/**
 * 检查字符串是否符合 unified diff 格式
 * 标准格式: @@ -n,m +n,m @@
 */
export function isUnifiedDiffFormat(diff: string): boolean {
  const lines = diff.trim().split("\n");

  if (lines.length < 3) {
    return false;
  }

  let hasHunkHeader = false;
  let hasValidContent = false;

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      // 忽略文件头
    } else if (line.match(/^@@ -\d+,?\d* \+\d+,?\d* @@/)) {
      hasHunkHeader = true;
    } else if (line.match(/^[+ -]/) || line === "") {
      hasValidContent = true;
    }
  }

  return hasHunkHeader && hasValidContent;
}

/**
 * 从 hunk 行中提取 "before" 部分（即删除行和上下文行）
 */
function extractBeforeLines(hunkLines: string[]): string[] {
  return hunkLines
    .filter((line) => line.startsWith("-") || !line.startsWith("+"))
    .map((line) => line.substring(1));
}

/**
 * 比较两行是否匹配（忽略行首空白）
 */
function linesMatch(a: string, b: string): boolean {
  const trimmedA = a.replace(/^\s+/, "");
  const trimmedB = b.replace(/^\s+/, "");
  return trimmedA === trimmedB;
}

/**
 * 在源码中搜索 hunk 的 "before" 块
 */
function findHunkInSource(
  sourceLines: string[],
  hunkBeforeLines: string[],
  startIndex: number,
): number {
  for (
    let i = startIndex;
    i <= sourceLines.length - hunkBeforeLines.length;
    i++
  ) {
    let match = true;
    for (let j = 0; j < hunkBeforeLines.length; j++) {
      const sl = sourceLines[i + j];
      const hl = hunkBeforeLines[j];
      if (!linesMatch(sl, hl)) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }
  return -1;
}

/**
 * 解析 unified diff 文本为 hunks 数组
 */
function parseUnifiedDiff(diffText: string): Hunk[] {
  const lines = diffText.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = { lines: [] };
      continue;
    }
    currentHunk?.lines.push(line);
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }
  return hunks;
}

/**
 * 应用 unified diff 到源码，返回 DiffLine 数组
 */
export function applyUnifiedDiff(
  sourceCode: string,
  unifiedDiffText: string,
): DiffLine[] {
  const sourceLines = sourceCode.split(/\r?\n/);
  const hunks = parseUnifiedDiff(unifiedDiffText);
  const diffResult: DiffLine[] = [];
  let currentPos = 0;

  for (const hunk of hunks) {
    const hunkBeforeLines = extractBeforeLines(hunk.lines);
    const hunkStart = findHunkInSource(sourceLines, hunkBeforeLines, currentPos);
    
    if (hunkStart === -1) {
      throw new Error("Hunk could not be applied cleanly to source code.");
    }

    // 输出 hunk 之前的未修改行
    for (let i = currentPos; i < hunkStart; i++) {
      diffResult.push({ type: "same", line: sourceLines[i] });
    }

    let hunkSourcePos = hunkStart;

    for (const dline of hunk.lines) {
      const srcLine = sourceLines[hunkSourcePos];
      if (dline.startsWith("+")) {
        // 新增行
        diffResult.push({ type: "new", line: dline.substring(1) });
      } else if (dline.startsWith("-")) {
        // 删除行
        diffResult.push({ type: "old", line: srcLine });
        hunkSourcePos++;
      } else {
        // 上下文行
        diffResult.push({ type: "same", line: srcLine });
        hunkSourcePos++;
      }
    }
    currentPos = hunkSourcePos;
  }

  // 输出剩余未修改行
  for (let i = currentPos; i < sourceLines.length; i++) {
    diffResult.push({ type: "same", line: sourceLines[i] });
  }

  return diffResult;
}

/**
 * 将 DiffLine[] 应用为 VS Code 的 WorkspaceEdit
 */
export async function applyDiffToFile(
  workspacePath: string,
  diffLines: DiffLine[],
): Promise<number> {
  if (!vscode.workspace.workspaceFolders) {
    throw new Error('No workspace folder is open');
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const workspaceUri = workspaceFolder.uri;
  const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);

  // 从 diff 结果重建新文件内容
  const newContent = diffLines
    .filter((line) => line.type !== "old")
    .map((line) => line.line)
    .join("\n");

  // 使用 WorkspaceEdit 写入文件
  const workspaceEdit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(0, 0, 999999, 999999);
  workspaceEdit.replace(fileUri, fullRange, newContent);

  const success = await vscode.workspace.applyEdit(workspaceEdit);

  if (!success) {
    throw new Error(`Failed to apply diff to file: ${workspacePath}`);
  }

  // 保存文件
  const document = await vscode.workspace.openTextDocument(fileUri);
  await document.save();

  // 计算统计
  const added = diffLines.filter((l) => l.type === "new").length;
  const removed = diffLines.filter((l) => l.type === "old").length;

  return added + removed;
}

/**
 * 生成 git style 的 diff 预览文本
 */
export function formatDiffPreview(
  workspacePath: string,
  diffLines: DiffLine[],
): string {
  const added = diffLines.filter((l) => l.type === "new").length;
  const removed = diffLines.filter((l) => l.type === "old").length;

  let result = `--- a/${workspacePath}\n+++ b/${workspacePath}\n`;
  result += `@@ -... +... @@ (${added} insertions, ${removed} deletions)\n\n`;

  let lineNum = 1;
  for (const dl of diffLines) {
    const prefix = dl.type === "new" ? "+" : dl.type === "old" ? "-" : " ";
    result += `${prefix}${dl.line}\n`;
    if (dl.type !== "new") lineNum++;
  }

  return result;
}

// ============================================================
// MCP 工具注册
// ============================================================

export function registerDiffTools(server: McpServer): void {
  // ---- apply_diff_code ----
  // 核心工具：通过 unified diff 格式精确编辑代码
  server.tool(
    'apply_diff_code',
    `通过 unified diff 格式精确编辑代码文件。

    这是推荐的代码编辑方式！AI 最擅长生成 unified diff 格式。

    格式要求 (标准 git diff 格式):
    \`\`\`
    @@ -旧起始行,旧行数 +新起始行,新行数 @@
    -要删除的原始行
    +要新增的新行
     上下文行（以空格开头）
    \`\`\`

    示例 - 将 "hello" 改为 "world":
    \`\`\`
    @@ -1,3 +1,3 @@
     const msg = "
    -hello
    +world
     ";
    \`\`\`

    注意事项:
    - ---/+++ 文件头可选
    - 上下文行（空格开头）用于定位，建议提供
    - 行首空白会被忽略（模糊匹配）
    - 所有 hunk 必须都能在源码中找到匹配`,
    {
      path: z.string().describe('要编辑的文件路径（相对工作区根目录）'),
      diff: z.string().describe('unified diff 格式的编辑内容'),
    },
    async ({ path, diff }): Promise<CallToolResult> => {
      console.log(`[apply_diff_code] Tool called with path=${path}`);

      try {
        // 1. 读取当前文件
        if (!vscode.workspace.workspaceFolders) {
          throw new Error('No workspace folder is open');
        }
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const workspaceUri = workspaceFolder.uri;
        const fileUri = vscode.Uri.joinPath(workspaceUri, path);

        const document = await vscode.workspace.openTextDocument(fileUri);
        const sourceCode = document.getText();

        // 2. 校验 diff 格式
        if (!isUnifiedDiffFormat(diff)) {
          throw new Error(
            'Invalid unified diff format. Expected format:\n' +
            '@@ -line,count +line,count @@\n' +
            ' context line\n' +
            '-removed line\n' +
            '+added line'
          );
        }

        // 3. 应用 diff
        const diffLines = applyUnifiedDiff(sourceCode, diff);

        // 4. 写回文件
        const changeCount = await applyDiffToFile(path, diffLines);

        // 5. 生成预览
        const preview = formatDiffPreview(path, diffLines);

        const result: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `✅ 成功应用 diff 到 ${path} (${changeCount} 处修改)\n\n修改预览:\n${preview}`
            }
          ]
        };
        console.log(`[apply_diff_code] Success: ${changeCount} changes`);
        return result;
      } catch (error) {
        console.error('[apply_diff_code] Error:', error);
        throw error;
      }
    }
  );

  // ---- preview_diff_code ----
  // 预览工具：在不修改文件的情况下预览 diff 效果
  server.tool(
    'preview_diff_code',
    `预览 unified diff 应用到文件的结果（只读，不修改文件）。

    在 apply_diff_code 之前使用，先确认 diff 效果是否正确。

    格式要求同 apply_diff_code。`,
    {
      path: z.string().describe('要预览的文件路径（相对工作区根目录）'),
      diff: z.string().describe('unified diff 格式的编辑内容'),
    },
    async ({ path, diff }): Promise<CallToolResult> => {
      console.log(`[preview_diff_code] Tool called with path=${path}`);

      try {
        if (!vscode.workspace.workspaceFolders) {
          throw new Error('No workspace folder is open');
        }
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const workspaceUri = workspaceFolder.uri;
        const fileUri = vscode.Uri.joinPath(workspaceUri, path);

        const document = await vscode.workspace.openTextDocument(fileUri);
        const sourceCode = document.getText();

        if (!isUnifiedDiffFormat(diff)) {
          throw new Error('Invalid unified diff format.');
        }

        const diffLines = applyUnifiedDiff(sourceCode, diff);

        const preview = formatDiffPreview(path, diffLines);
        const added = diffLines.filter((l) => l.type === "new").length;
        const removed = diffLines.filter((l) => l.type === "old").length;

        const result: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `📋 预览 diff 应用到 ${path}\n${added} 处新增, ${removed} 处删除\n\n${preview}\n\n使用 apply_diff_code 应用此修改。`
            }
          ]
        };
        return result;
      } catch (error) {
        console.error('[preview_diff_code] Error:', error);
        throw error;
      }
    }
  );
}
