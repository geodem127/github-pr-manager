import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface ClaudeEvent {
  type: 'status' | 'text';
  text: string;
}

export interface SuggestedEdit {
  file: string;
  search: string;
  replace: string;
}

export const EDIT_FORMAT_INSTRUCTIONS = `
When you propose code changes, output each change ONLY in this exact format (no diff syntax, no other change formats):

<<<FILE: relative/path/from/repo/root
<<<SEARCH
(exact code currently in the file, copied verbatim)
===REPLACE
(the new code)
>>>END

Use one block per change. For a brand-new file, leave the SEARCH section empty.
Outside these blocks, explain your reasoning briefly.`;

const EDIT_BLOCK_RE =
  /<<<FILE:\s*(.+?)\r?\n<<<SEARCH\r?\n([\s\S]*?)===REPLACE\r?\n([\s\S]*?)>>>END/g;

export function parseSuggestedEdits(text: string): SuggestedEdit[] {
  const edits: SuggestedEdit[] = [];
  for (const m of text.matchAll(EDIT_BLOCK_RE)) {
    edits.push({
      file: m[1].trim(),
      search: m[2].replace(/\r?\n$/, ''),
      replace: m[3].replace(/\r?\n$/, ''),
    });
  }
  return edits;
}

export async function applySuggestedEdits(
  edits: SuggestedEdit[]
): Promise<{ applied: string[]; failed: string[] }> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('No workspace folder open.');
  const applied: string[] = [];
  const failed: string[] = [];

  for (const edit of edits) {
    const uri = vscode.Uri.joinPath(root, edit.file);
    try {
      if (!edit.search.trim()) {
        // New file (or full overwrite of an empty target).
        await vscode.workspace.fs.writeFile(uri, Buffer.from(edit.replace, 'utf8'));
        applied.push(edit.file);
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      const idx = content.indexOf(edit.search);
      if (idx === -1) {
        failed.push(`${edit.file} (search text not found)`);
        continue;
      }
      const ws = new vscode.WorkspaceEdit();
      ws.replace(uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + edit.search.length)), edit.replace);
      const ok = await vscode.workspace.applyEdit(ws);
      if (ok) {
        await doc.save();
        applied.push(edit.file);
      } else {
        failed.push(edit.file);
      }
    } catch (err) {
      failed.push(`${edit.file} (${err instanceof Error ? err.message : err})`);
    }
  }
  return { applied, failed };
}

/**
 * Runs the Claude Code CLI in non-interactive mode with streaming output.
 * Resolves with the final result text.
 */
export function runClaude(
  prompt: string,
  onEvent: (e: ClaudeEvent) => void,
  token?: vscode.CancellationToken
): Promise<string> {
  const config = vscode.workspace.getConfiguration('prManager');
  const cli = config.get<string>('claudeCliPath', 'claude');
  const model = config.get<string>('claudeModel', '');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return Promise.reject(new Error('No workspace folder open.'));

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd,
      shell: process.platform === 'win32',
      env: process.env,
    });

    token?.onCancellationRequested(() => {
      child.kill();
      reject(new Error('Cancelled.'));
    });

    let result = '';
    let collectedText = '';
    let stderr = '';
    let buffer = '';

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        onEvent({ type: 'status', text: 'Claude session started…' });
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            collectedText += block.text;
            onEvent({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            const target =
              block.input?.file_path ?? block.input?.path ?? block.input?.pattern ?? '';
            onEvent({ type: 'status', text: `Using ${block.name}${target ? `: ${target}` : ''}` });
          }
        }
      } else if (msg.type === 'result') {
        result = typeof msg.result === 'string' ? msg.result : collectedText;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(
              `Claude CLI not found at "${cli}". Install Claude Code or set prManager.claudeCliPath.`
            )
          : err
      );
    });

    child.on('close', (code) => {
      if (buffer) handleLine(buffer);
      if (code === 0) {
        resolve(result || collectedText || '(no response)');
      } else {
        reject(new Error(`Claude CLI exited with code ${code}. ${stderr.slice(0, 400)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
