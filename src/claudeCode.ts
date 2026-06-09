import * as vscode from 'vscode';

const CONTEXT_FILE = '.claude-pr-context.md';

/**
 * Bridges PR comments/reviews into the real Claude Code CLI session.
 *
 * Rather than reimplementing Claude Code's chat (slash commands, autocomplete,
 * tool use, …), we run the genuine `claude` CLI in an integrated terminal and
 * feed attached comments to it via a workspace context file referenced with an
 * @-mention — so the user gets the full Claude Code experience plus our
 * attach-comment workflow.
 */
export class ClaudeCodeBridge {
  private terminal?: vscode.Terminal;
  private items: Array<{ label: string; content: string }> = [];

  /** Adds a comment/review to the Claude Code context and (re)sends it. */
  async addContext(label: string, content: string): Promise<void> {
    this.items.push({ label, content });
    await this.writeContextFile();
    const fresh = !this.terminal || this.terminal.exitStatus !== undefined;
    const term = this.ensureTerminal();
    term.show();
    const intro = fresh
      ? `I've attached PR review context in @${CONTEXT_FILE} (latest item: ${label}). Help me address it.`
      : `Updated PR context in @${CONTEXT_FILE} — added: ${label}.`;
    // A short delay lets a freshly-spawned `claude` reach its prompt first.
    setTimeout(() => term.sendText(intro, true), fresh ? 1200 : 150);
  }

  /** Opens Claude Code without adding anything new. */
  open(): void {
    this.ensureTerminal().show();
  }

  clear(): void {
    this.items = [];
  }

  private ensureTerminal(): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal;
    const cli = vscode.workspace
      .getConfiguration('prManager')
      .get<string>('claudeCliPath', 'claude');
    this.terminal = vscode.window.createTerminal({
      name: 'Claude Code',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    this.terminal.sendText(cli, true);
    return this.terminal;
  }

  private async writeContextFile(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const body = this.items
      .map((it, i) => `## ${i + 1}. ${it.label}\n\n${it.content}`)
      .join('\n\n---\n\n');
    const header = `# PR review context\n\n_Attached from GitHub PR Manager. ${this.items.length} item(s)._\n\n`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, CONTEXT_FILE),
      Buffer.from(header + body, 'utf8')
    );
    await this.ensureGitignored(root);
  }

  private async ensureGitignored(root: vscode.Uri): Promise<void> {
    const uri = vscode.Uri.joinPath(root, '.gitignore');
    try {
      const existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (existing.split('\n').some((l) => l.trim() === CONTEXT_FILE)) return;
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(`${existing.replace(/\n*$/, '\n')}${CONTEXT_FILE}\n`, 'utf8')
      );
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(`${CONTEXT_FILE}\n`, 'utf8'));
    }
  }
}
