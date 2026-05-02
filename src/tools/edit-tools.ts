import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Creates a new file in the VS Code workspace using WorkspaceEdit
 * @param workspacePath The path within the workspace to the file
 * @param content The content to write to the file
 * @param overwrite Whether to overwrite if the file exists
 * @param ignoreIfExists Whether to ignore if the file exists
 * @returns Promise that resolves when the edit operation completes
 */
export async function createWorkspaceFile(
    workspacePath: string,
    content: string,
    overwrite: boolean = false,
    ignoreIfExists: boolean = false
): Promise<void> {
    console.log(`[createWorkspaceFile] Starting with path: ${workspacePath}, overwrite: ${overwrite}, ignoreIfExists: ${ignoreIfExists}`);
    
    if (!vscode.workspace.workspaceFolders) {
        throw new Error('No workspace folder is open');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceUri = workspaceFolder.uri;
    
    // Create URI for the target file
    const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
    console.log(`[createWorkspaceFile] File URI: ${fileUri.fsPath}`);

    try {
        // Create a WorkspaceEdit
        const workspaceEdit = new vscode.WorkspaceEdit();
        
        // Convert content to Uint8Array
        const contentBuffer = new TextEncoder().encode(content);
        
        // Add createFile operation to the edit
        workspaceEdit.createFile(fileUri, {
            contents: contentBuffer,
            overwrite: overwrite,
            ignoreIfExists: ignoreIfExists
        });
        
        // Apply the edit
        const success = await vscode.workspace.applyEdit(workspaceEdit);
        
        if (success) {
            console.log(`[createWorkspaceFile] File created successfully: ${fileUri.fsPath}`);
            
            // Open the document to trigger linting
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            console.log(`[createWorkspaceFile] File opened in editor`);
        } else {
            throw new Error(`Failed to create file: ${fileUri.fsPath}`);
        }
    } catch (error) {
        console.error('[createWorkspaceFile] Error:', error);
        throw error;
    }
}

/**
 * Replaces specific lines in a file in the VS Code workspace
 * @param workspacePath The path within the workspace to the file
 * @param startLine The start line number (0-based, inclusive)
 * @param endLine The end line number (0-based, inclusive)
 * @param content The new content to replace the lines with
 * @param originalCode The original code for validation
 * @returns Promise that resolves when the edit operation completes
 */
export async function replaceWorkspaceFileLines(
    workspacePath: string,
    startLine: number,
    endLine: number,
    content: string,
    originalCode: string
): Promise<void> {
    console.log(`[replaceWorkspaceFileLines] Starting with path: ${workspacePath}, lines: ${startLine}-${endLine}`);
    
    if (!vscode.workspace.workspaceFolders) {
        throw new Error('No workspace folder is open');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceUri = workspaceFolder.uri;
    
    // Create URI for the target file
    const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
    console.log(`[replaceWorkspaceFileLines] File URI: ${fileUri.fsPath}`);

    try {
        // Open the document (or get it if already open)
        const document = await vscode.workspace.openTextDocument(fileUri);
        
        // Validate line numbers
        if (startLine < 0 || startLine >= document.lineCount) {
            throw new Error(`Start line ${startLine + 1} is out of range (1-${document.lineCount})`);
        }
        if (endLine < startLine || endLine >= document.lineCount) {
            throw new Error(`End line ${endLine + 1} is out of range (${startLine + 1}-${document.lineCount})`);
        }
        
        // Get the text within the specified line range
        const rangeStartOffset = document.offsetAt(new vscode.Position(startLine, 0));
        const rangeEndOffset = endLine < document.lineCount - 1
            ? document.offsetAt(new vscode.Position(endLine + 1, 0))
            : document.getText().length;
        const rangeText = document.getText().substring(rangeStartOffset, rangeEndOffset);
        
        // Search for originalCode as substring (like desktop_edit_block)
        const matchIndex = rangeText.indexOf(originalCode);
        if (matchIndex === -1) {
            const preview = rangeText.length > 200 
                ? rangeText.substring(0, 200) + '...' 
                : rangeText;
            throw new Error(
                `Original code not found in lines ${startLine + 1}-${endLine + 1}. ` +
                `Line range content preview:\n${preview}`
            );
        }
        
        // Calculate exact position of the match
        const matchOffset = rangeStartOffset + matchIndex;
        const matchStartPos = document.positionAt(matchOffset);
        const matchEndPos = document.positionAt(matchOffset + originalCode.length);
        const matchRange = new vscode.Range(matchStartPos, matchEndPos);
        
        // Get the active text editor or show the document
        let editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== fileUri.toString()) {
            editor = await vscode.window.showTextDocument(document);
        }
        
        // Apply the edit
        const success = await editor.edit((editBuilder) => {
            editBuilder.replace(matchRange, content);
        });
        
        if (success) {
            console.log(`[replaceWorkspaceFileLines] Lines replaced successfully`);
            
            // Save the document to persist changes
            await document.save();
            console.log(`[replaceWorkspaceFileLines] Document saved`);
        } else {
            throw new Error(`Failed to replace lines in file: ${fileUri.fsPath}`);
        }
    } catch (error) {
        console.error('[replaceWorkspaceFileLines] Error:', error);
        throw error;
    }
}

/**
 * Escapes special regex characters for literal string matching
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces text in a file using regex pattern matching — no line numbers needed!
 * @param workspacePath The path within the workspace to the file
 * @param pattern The regex pattern (or literal string if literal=true)
 * @param replacement The replacement string
 * @param literal Whether to treat pattern as literal string (default false = regex)
 * @param expectedReplacements Optional: expected number of replacements, throws if mismatch
 * @param startLine Optional: 1-based start line (inclusive), default 1 = beginning
 * @param endLine Optional: 1-based end line (inclusive), default = end of file
 * @returns Number of replacements made
 */
export async function replaceWorkspaceFileByRegex(
    workspacePath: string,
    pattern: string,
    replacement: string,
    literal: boolean = false,
    expectedReplacements?: number,
    startLine?: number,
    endLine?: number
): Promise<number> {
    console.log(`[replaceWorkspaceFileByRegex] path: ${workspacePath}, pattern: ${pattern}, literal: ${literal}, startLine: ${startLine}, endLine: ${endLine}`);
    
    if (!vscode.workspace.workspaceFolders) {
        throw new Error('No workspace folder is open');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const workspaceUri = workspaceFolder.uri;
    const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
    
    try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const fullText = document.getText();
        
        // Determine the text range to search in
        let searchText: string;
        let rangeStartOffset: number;
        let rangeEndOffset: number;
        
        if (startLine === undefined && endLine === undefined) {
            // Search entire file
            searchText = fullText;
            rangeStartOffset = 0;
            rangeEndOffset = fullText.length;
        } else {
            const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
            const end = endLine !== undefined ? Math.min(document.lineCount - 1, endLine - 1) : document.lineCount - 1;
            
            if (start > end) {
                throw new Error(`startLine (${startLine}) cannot be greater than endLine (${endLine})`);
            }
            
            rangeStartOffset = document.offsetAt(new vscode.Position(start, 0));
            rangeEndOffset = end < document.lineCount - 1 
                ? document.offsetAt(new vscode.Position(end + 1, 0))
                : fullText.length;
            
            searchText = fullText.substring(rangeStartOffset, rangeEndOffset);
        }
        
        // Build regex with global flag
        let regex: RegExp;
        try {
            regex = literal 
                ? new RegExp(escapeRegex(pattern), 'g')
                : new RegExp(pattern, 'gm');
        } catch (e) {
            throw new Error(`Invalid regex pattern: ${pattern} — ${e instanceof Error ? e.message : String(e)}`);
        }
        
        // Count matches before replacement (only within range)
        const matches = searchText.match(regex);
        const actualCount = matches ? matches.length : 0;
        
        // If expected count specified, verify it
        if (expectedReplacements !== undefined && actualCount !== expectedReplacements) {
            throw new Error(
                `Expected ${expectedReplacements} replacement(s), but pattern matched ${actualCount} time(s). ` +
                `No changes were made.`
            );
        }
        
        if (actualCount === 0) {
            return 0; // No matches, nothing to do
        }
        
        // Perform replacement only within the specified range
        const newSearchText = searchText.replace(regex, replacement);
        const newText = fullText.substring(0, rangeStartOffset) + newSearchText + fullText.substring(rangeEndOffset);
        
        // Apply via WorkspaceEdit (full document replace)
        const workspaceEdit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(fullText.length)
        );
        workspaceEdit.replace(fileUri, fullRange, newText);
        
        const success = await vscode.workspace.applyEdit(workspaceEdit);
        
        if (success) {
            await document.save();
            console.log(`[replaceWorkspaceFileByRegex] ${actualCount} replacement(s) made`);
        } else {
            throw new Error(`Failed to apply regex replacement to file: ${fileUri.fsPath}`);
        }
        
        return actualCount;
    } catch (error) {
        console.error('[replaceWorkspaceFileByRegex] Error:', error);
        throw error;
    }
}

/**
 * Registers MCP edit-related tools with the server
 * @param server MCP server instance
 */
export function registerEditTools(server: McpServer): void {
    // Add create_file tool
    server.tool(
        'create_file_code',
        `Creates new files or completely rewrites existing files.

        WHEN TO USE: New files, large modifications (>10 lines), complete file rewrites.
        USE replace_lines_code instead for: small edits ≤10 lines where you have exact original content.

        File handling: Use overwrite=true to replace existing files, ignoreIfExists=true to skip if file exists.
        Always check with list_files_code first unless you specifically want to overwrite.`,
        {
            path: z.string().describe('The path to the file to create'),
            content: z.string().describe('The content to write to the file'),
            overwrite: z.boolean().optional().default(false).describe('Whether to overwrite if the file exists'),
            ignoreIfExists: z.boolean().optional().default(false).describe('Whether to ignore if the file exists')
        },
        async ({ path, content, overwrite = false, ignoreIfExists = false }): Promise<CallToolResult> => {
            console.log(`[create_file] Tool called with path=${path}, overwrite=${overwrite}, ignoreIfExists=${ignoreIfExists}`);
            
            try {
                console.log('[create_file] Creating file');
                await createWorkspaceFile(path, content, overwrite, ignoreIfExists);
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `File ${path} created successfully`
                        }
                    ]
                };
                console.log('[create_file] Successfully completed');
                return result;
            } catch (error) {
                console.error('[create_file] Error in tool:', error);
                throw error;
            }
        }
    );

    // Add replace_lines_code tool
    server.tool(
        'replace_lines_code',
        `Replaces specific lines in existing files with exact content validation.

        WHEN TO USE: Modifications ≤10 lines where you have exact original text, or inserts of any size.
        USE create_file_code instead for: new files, large modifications (>10 lines), or when original text is uncertain.

        HOW IT WORKS: Searches for originalCode as a SUBSTRING within [startLine, endLine].
        Only the matched text is replaced — surrounding content stays unchanged.
        This is like desktop_edit_block — no need to match the entire line range!

        CRITICAL: originalCode must be found as-is within the line range.
        If tool fails: run read_file_code to check current content, then retry.
        Parameters use 1-based line numbers.`,
        {
            path: z.string().describe('The path to the file to modify'),
            startLine: z.number().describe('The start line number (1-based, inclusive)'),
            endLine: z.number().describe('The end line number (1-based, inclusive)'),
            content: z.string().describe('The new content to replace the lines with'),
            originalCode: z.string().describe('The original code for validation - must match exactly')
        },
        async ({ path, startLine, endLine, content, originalCode }): Promise<CallToolResult> => {
            console.log(`[replace_lines_code] Tool called with path=${path}, startLine=${startLine}, endLine=${endLine}`);
            
            // Convert 1-based input to 0-based for VS Code API
            const zeroBasedStartLine = startLine - 1;
            const zeroBasedEndLine = endLine - 1;
            
            try {
                console.log('[replace_lines_code] Replacing lines');
                await replaceWorkspaceFileLines(path, zeroBasedStartLine, zeroBasedEndLine, content, originalCode);
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Replace succeed in ${path}: originalCode found within lines ${startLine}-${endLine}, matched text replaced`
                        }
                    ]
                };
                console.log('[replace_lines_code] Successfully completed');
                return result;
            } catch (error) {
                console.error('[replace_lines_code] Error in tool:', error);
                throw error;
            }
        }
    );

    // Add replace_regex_code tool
    server.tool(
        'replace_regex_code',
        `Searches and replaces text in files using regular expressions (or literal strings).

        WHEN TO USE: Any text replacement where you know WHAT to change but not WHERE (line numbers).
        This is the RECOMMENDED tool for most edits — no line numbers or originalCode validation needed!

        HOW IT WORKS:
        1. pattern is compiled as a RegExp with 'gm' flags (global + multiline)
        2. All matches are replaced with replacement string
        3. Returns the count of replacements made

        TIPS:
        - Use literal=true for simple string find-and-replace (no regex escaping needed)
        - Use expectedReplacements to verify the right number of changes are made
        - Use startLine/endLine to limit search scope (both optional, 1-based, inclusive)
        - For large files, be specific with your pattern to avoid unintended matches
        - The tool uses VS Code's WorkspaceEdit for proper undo support`,
        {
            path: z.string().describe('The path to the file to modify'),
            pattern: z.string().describe('The regex pattern (or literal string if literal=true) to search for'),
            replacement: z.string().describe('The replacement text'),
            literal: z.boolean().optional().default(false).describe('If true, pattern is treated as a literal string (no regex). Default: false'),
            expectedReplacements: z.number().optional().describe('Expected number of replacements. If specified and actual count differs, throws error without changing file.'),
            startLine: z.number().optional().describe('Optional: 1-based start line (inclusive). Default: 1 (beginning of file)'),
            endLine: z.number().optional().describe('Optional: 1-based end line (inclusive). Default: end of file')
        },
        async ({ path, pattern, replacement, literal = false, expectedReplacements, startLine, endLine }): Promise<CallToolResult> => {
            console.log(`[replace_regex_code] Tool called with path=${path}, pattern=${pattern}, literal=${literal}, startLine=${startLine}, endLine=${endLine}`);
            
            try {
                const count = await replaceWorkspaceFileByRegex(path, pattern, replacement, literal, expectedReplacements, startLine, endLine);
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: count > 0
                                ? `Regex replace: ${count} replacement(s) made in ${path}`
                                : `Regex replace: no matches found in ${path}`
                        }
                    ]
                };
                console.log('[replace_regex_code] Successfully completed');
                return result;
            } catch (error) {
                console.error('[replace_regex_code] Error in tool:', error);
                throw error;
            }
        }
    );
}