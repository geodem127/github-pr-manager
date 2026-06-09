import * as vscode from 'vscode';

const CONTEXT_FILE = '.claude-pr-context.md';

const DEFAULT_INSTRUCTIONS = `# Instructions for handling PR context

The file ${CONTEXT_FILE} contains GitHub pull-request comments, reviews, and
related code context that the user has attached for you to work on.

When the user references this context:
- Treat each item as a review comment or instruction to address.
- All details you need (file paths, line numbers, diff hunks, author, status)
  are included inline — do not fetch anything from GitHub or the network.
- Propose minimal, focused changes consistent with the existing code style.
- Wait for the user's explicit instruction before editing files.
`;

/**
 * Bridges PR comments/reviews into the real Claude Code CLI session.
 *
 * Runs the genuine \`claude\` CLI in an integrated terminal (full chat: slash
 * commands, autocomplete, tool use) and exposes attached comments through a
 * gitignored @-mention context file — without auto-prompting Claude.
 */
export class ClaudeCodeBridge {
  private terminal?: vscode.Terminal;
  private items: Array<{ label: string; content: string }> = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Adds a comment/review to the context file (deduped) and reveals Claude Code. */
  async addContext(label: string, content: string): Promise<void> {
    if (this.items.some((it) => it.content === content)) {
      vscode.window.setStatusBarMessage('Already in Claude context', 2000);
      this.ensureTerminal().show();
      return;
    }
    this.items.push({ label, content });
    await this.writeContextFile();
    this.ensureTerminal().show();
    vscode.window.setStatusBarMessage(`Added to Claude context: ${label}`, 2500);
    // No auto-prompt: the user drives Claude. Context lives in @${CONTEXT_FILE}.
  }

  /**
   * Adds context and hands it to the official Claude Code extension's chat
   * panel (the "CLAUDE CODE" view) rather than a terminal.
   */
  async addContextToChat(label: string, content: string): Promise<void> {
    if (!this.items.some((it) => it.content === content)) {
      this.items.push({ label, content });
      await this.writeContextFile();
    }
    const prompt = `Review the attached PR context in @${CONTEXT_FILE} (latest: ${label}) and help me address it.`;
    await this.focusClaudeCode();
    const sent = await this.sendToClaudeCode(prompt);
    if (!sent) {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        `Context added to @${CONTEXT_FILE}. Prompt copied — paste it into Claude Code (⌘/Ctrl+V).`
      );
    }
  }

  /** Best-effort focus of the official Claude Code view. */
  private async focusClaudeCode(): Promise<void> {
    const all = await vscode.commands.getCommands(true);
    const focusCmd =
      all.find((c) => /claude/i.test(c) && /focus/i.test(c)) ??
      ['claude-code.focus', 'anthropic.claude-code.focus', 'workbench.view.extension.claude-code'].find(
        (c) => all.includes(c)
      );
    if (focusCmd) {
      try {
        await vscode.commands.executeCommand(focusCmd);
      } catch {
        // ignore — fall back to clipboard
      }
    }
  }

  /**
   * Tries to send a prompt to Claude Code. Uses a user-configured command if
   * set (prManager.claudeCodeSendCommand), else attempts discovered candidates.
   * Returns true only when a command executed without throwing.
   */
  private async sendToClaudeCode(prompt: string): Promise<boolean> {
    const configured = vscode.workspace
      .getConfiguration('prManager')
      .get<string>('claudeCodeSendCommand', '');
    const candidates = configured ? [configured] : [];
    if (!configured) {
      const all = await vscode.commands.getCommands(true);
      candidates.push(
        ...all.filter((c) => /claude/i.test(c) && /(send|prompt|query|ask|message|newChat|new-chat)/i.test(c))
      );
    }
    for (const cmd of candidates) {
      try {
        await vscode.commands.executeCommand(cmd, prompt);
        return true;
      } catch {
        // try next candidate
      }
    }
    return false;
  }

  /** Lists the commands the installed Claude Code extension exposes. */
  async discoverCommands(): Promise<void> {
    const all = await vscode.commands.getCommands(true);
    const claude = all.filter((c) => /claude|anthropic/i.test(c)).sort();
    if (claude.length === 0) {
      vscode.window.showInformationMessage(
        'No Claude Code commands found. Is the Claude Code extension installed?'
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(claude, {
      title: 'Claude Code commands (pick one to set as the "send" command)',
      placeHolder: 'Selecting sets prManager.claudeCodeSendCommand',
    });
    if (pick) {
      await vscode.workspace
        .getConfiguration('prManager')
        .update('claudeCodeSendCommand', pick, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Set Claude Code send command to "${pick}".`);
    }
  }

  /** Opens Claude Code without adding anything. */
  open(): void {
    this.ensureTerminal().show();
  }

  /** Drops all attached context and removes the context file. */
  async clear(): Promise<void> {
    this.items = [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, CONTEXT_FILE));
    } catch {
      // already gone
    }
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

  private async instructions(): Promise<string> {
    const configured = vscode.workspace
      .getConfiguration('prManager')
      .get<string>('instructionsPath', '');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    // 1) user-configured path (absolute or workspace-relative)
    if (configured && root) {
      try {
        const uri = configured.match(/^(\/|[A-Za-z]:)/)
          ? vscode.Uri.file(configured)
          : vscode.Uri.joinPath(root, configured);
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        // fall through to bundled default
      }
    }
    // 2) bundled default
    try {
      const uri = vscode.Uri.joinPath(this.extensionUri, 'media', 'claude-instructions.md');
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return DEFAULT_INSTRUCTIONS;
    }
  }

  private async writeContextFile(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const body = this.items
      .map((it, i) => `## ${i + 1}. ${it.label}\n\n${it.content}`)
      .join('\n\n---\n\n');
    const doc = `${(await this.instructions()).trim()}\n\n---\n\n# Attached context (${this.items.length})\n\n${body}\n`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, CONTEXT_FILE),
      Buffer.from(doc, 'utf8')
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
