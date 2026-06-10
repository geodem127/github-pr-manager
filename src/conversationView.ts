import * as vscode from 'vscode';
import { GitHubClient, PullRequest, Thread, Comment } from './github';
import { escapeHtml, renderMarkdown } from './markdown';
import {
  runClaude,
  parseSuggestedEdits,
  applySuggestedEdits,
  EDIT_FORMAT_INSTRUCTIONS,
} from './claude';

interface ChatTurn {
  role: 'user' | 'claude';
  text: string;
}

const FILE_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';

export class ConversationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'prManager.conversation';

  private view?: vscode.WebviewView;
  private pr?: PullRequest;
  private thread?: Thread;
  private chat: ChatTurn[] = [];
  private responses = new Map<string, string>();
  private contextItems: Array<{ label: string; content: string }> = [];
  private busy = false;
  private cancelSource?: vscode.CancellationTokenSource;

  constructor(
    private readonly client: GitHubClient,
    private readonly onReplied?: () => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.shellHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'ready':
          this.pushThread();
          this.pushContext();
          void this.slashCommands().then((items) =>
            this.view?.webview.postMessage({ command: 'slashList', items })
          );
          break;
        case 'generateFix':
          await this.askClaude(
            'Investigate the relevant code in this repository and propose a concrete fix that addresses the reviewer comment(s) above. Keep the change minimal and consistent with the existing code style.',
            'Generate fix'
          );
          break;
        case 'chat':
          if (typeof msg.text === 'string' && msg.text.trim()) {
            const raw = msg.text.trim();
            if (raw.startsWith('/')) {
              const resolved = await this.resolveSlash(raw);
              if (resolved.unsupported) {
                vscode.window.showWarningMessage(
                  `"/${resolved.unsupported}" isn't available in the built-in chat. ` +
                    `Interactive Claude Code commands work in terminal mode (prManager.chatMode); ` +
                    `custom commands live in .claude/commands.`
                );
                break;
              }
              await this.askClaude(resolved.prompt ?? raw, raw.split(/\s/)[0]);
            } else {
              await this.askClaude(raw, null);
            }
          }
          break;
        case 'generateReply':
          await this.generateReply();
          break;
        case 'removeContext':
          if (typeof msg.index === 'number') {
            this.contextItems.splice(msg.index, 1);
            this.pushContext();
          }
          break;
        case 'clearContext':
          this.contextItems = [];
          this.pushContext();
          break;
        case 'reply':
          if (typeof msg.text === 'string' && msg.text.trim()) {
            await this.postReply(msg.text.trim());
          }
          break;
        case 'applySuggestion':
          if (typeof msg.rid === 'string') await this.applyResponse(msg.rid);
          break;
        case 'openFile':
          if (typeof msg.path === 'string') await this.openFile(msg.path);
          break;
        case 'upload':
          await this.uploadToContext();
          break;
        case 'slashCommands':
          await this.pickSlashCommand();
          break;
        case 'cancel':
          this.cancelSource?.cancel();
          break;
        case 'openExternal':
          if (typeof msg.url === 'string') {
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
      }
    });
  }

  /** Blank the panel (no conversation selected). */
  clear(): void {
    this.pr = undefined;
    this.thread = undefined;
    this.chat = [];
    this.responses.clear();
    this.contextItems = [];
    void this.view?.webview.postMessage({ command: 'clear' });
  }

  /** Adds a comment/review to the chat's context and reveals the panel. */
  addContext(label: string, content: string): void {
    if (this.contextItems.some((c) => c.content === content)) {
      vscode.window.setStatusBarMessage('Already in Claude context', 2000);
      this.view?.show?.(true);
      return;
    }
    this.contextItems.push({ label, content });
    const reveal = () => {
      this.view?.show?.(true);
      this.pushContext();
    };
    if (this.view) {
      reveal();
    } else {
      vscode.commands.executeCommand(`${ConversationViewProvider.viewId}.focus`);
      setTimeout(reveal, 400);
    }
  }

  private pushContext(): void {
    void this.view?.webview.postMessage({
      command: 'setContext',
      items: this.contextItems.map((c) => c.label),
    });
  }

  /** Drafts a reply with Claude and drops it into the reply box (no chat-log noise). */
  private async generateReply(): Promise<void> {
    if (!this.view) return;
    if (this.busy) {
      vscode.window.showWarningMessage('Claude is already working — wait or cancel first.');
      return;
    }
    const ctx = this.contextItems.length
      ? this.contextItems.map((c) => c.content).join('\n\n')
      : this.threadContext();
    if (!ctx) {
      vscode.window.showWarningMessage('Add a comment/review to context first.');
      return;
    }
    const prompt =
      `${ctx}\n\n--- Task ---\n` +
      `Draft a concise, professional reply I can post to the above PR review comment(s). ` +
      `Output ONLY the reply text — no preamble, no markdown code fences.`;
    this.busy = true;
    this.cancelSource = new vscode.CancellationTokenSource();
    this.view.webview.postMessage({ command: 'claudeStart', label: 'Generating reply…' });
    try {
      const result = await runClaude(
        prompt,
        (e) => this.view?.webview.postMessage({ command: 'claudeEvent', kind: e.type, text: e.text }),
        this.cancelSource.token
      );
      this.view.webview.postMessage({ command: 'claudeDone', rid: '', html: '', editsHtml: '', canApply: false });
      this.view.webview.postMessage({ command: 'replyDraft', text: result.trim() });
    } catch (err) {
      this.view.webview.postMessage({
        command: 'claudeError',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
      this.cancelSource = undefined;
    }
  }

  /** Resolves a /command in the built-in chat: expands custom command files, flags unsupported. */
  private async resolveSlash(
    text: string
  ): Promise<{ prompt?: string; unsupported?: string }> {
    const m = text.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
    if (!m) return {};
    const name = m[1];
    const args = m[2] ?? '';
    const rel = name.replace(/:/g, '/') + '.md';
    const roots: vscode.Uri[] = [];
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (ws) roots.push(vscode.Uri.joinPath(ws, '.claude', 'commands', rel));
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) roots.push(vscode.Uri.joinPath(vscode.Uri.file(home), '.claude', 'commands', rel));
    for (const uri of roots) {
      try {
        const body = Buffer.from(await vscode.workspace.fs.readFile(uri))
          .toString('utf8')
          .replace(/^---\s*[\s\S]*?---\s*/, ''); // strip frontmatter
        const argList = args.split(/\s+/).filter(Boolean);
        const prompt = body
          .replace(/\$ARGUMENTS/g, args)
          .replace(/\$(\d+)/g, (_s, n) => argList[Number(n) - 1] ?? '');
        return { prompt: prompt.trim() };
      } catch {
        // not in this root
      }
    }
    return { unsupported: name };
  }

  /** Lets the user pick files/folders and adds them to the Claude context. */
  private async uploadToContext(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add to Claude context',
    });
    if (!picks?.length) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const uri of picks) {
      const full = uri.fsPath;
      const rel = root && full.startsWith(root) ? full.slice(root.length).replace(/^[/\\]/, '') : full;
      let stat: vscode.FileStat | undefined;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        /* ignore */
      }
      const isDir = stat?.type === vscode.FileType.Directory;
      const label = (isDir ? '📁 ' : '📄 ') + rel;
      if (this.contextItems.some((c) => c.label === label)) continue;
      // Reference by @-path so Claude reads it itself — keep the payload tiny.
      this.contextItems.push({ label, content: `Attached ${isDir ? 'folder' : 'file'}: @${rel}` });
    }
    this.view?.show?.(true);
    this.pushContext();
  }

  /** Re-enumerates slash commands and pushes them to the webview, then opens the popup. */
  private async pickSlashCommand(): Promise<void> {
    const list = await this.slashCommands();
    void this.view?.webview.postMessage({ command: 'slashList', items: list });
    void this.view?.webview.postMessage({ command: 'openSlash' });
  }

  /** Built-in + discovered custom Claude slash commands. */
  private async slashCommands(): Promise<Array<{ label: string; description: string }>> {
    const builtins: Array<{ label: string; description: string }> = [
      { label: '/help', description: 'List available commands' },
      { label: '/clear', description: 'Clear conversation history' },
      { label: '/compact', description: 'Summarize and compact the conversation' },
      { label: '/review', description: 'Review the current changes' },
      { label: '/init', description: 'Initialize a CLAUDE.md for the project' },
      { label: '/cost', description: 'Show token usage and cost' },
      { label: '/model', description: 'Change the active model' },
      { label: '/memory', description: 'Edit CLAUDE.md memory' },
      { label: '/agents', description: 'Manage subagents' },
      { label: '/mcp', description: 'Manage MCP servers' },
    ];

    const custom: Array<{ label: string; description: string }> = [];
    const roots: Array<{ base: vscode.Uri; scope: string }> = [];
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (ws) roots.push({ base: vscode.Uri.joinPath(ws, '.claude', 'commands'), scope: 'project' });
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      roots.push({ base: vscode.Uri.joinPath(vscode.Uri.file(home), '.claude', 'commands'), scope: 'user' });
    }
    for (const { base, scope } of roots) {
      await this.collectCommands(base, base, scope, custom);
    }

    const items = [...builtins, ...custom];
    const seen = new Set<string>();
    return items.filter((i) => (seen.has(i.label) ? false : seen.add(i.label)));
  }

  /** Recursively collects custom slash commands from a .claude/commands dir. */
  private async collectCommands(
    root: vscode.Uri,
    dir: vscode.Uri,
    scope: string,
    out: Array<{ label: string; description: string }>
  ): Promise<void> {
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return; // dir doesn't exist
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await this.collectCommands(root, child, scope, out);
      } else if (name.endsWith('.md')) {
        const relPath = child.path.slice(root.path.length + 1).replace(/\.md$/, '');
        const cmd = '/' + relPath.replace(/\//g, ':'); // namespacing → /dir:name
        let description = '';
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(child)).toString('utf8');
          const fm = text.match(/^---\s*[\s\S]*?\bdescription:\s*(.+)$/m);
          description = (fm?.[1] ?? text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? '')
            .trim()
            .slice(0, 80);
        } catch {
          /* ignore */
        }
        out.push({ label: cmd, description });
      }
    }
  }

  showThread(pr: PullRequest, thread: Thread): void {
    this.pr = pr;
    this.thread = thread;
    this.chat = [];
    this.responses.clear();
    if (this.view) {
      this.view.show?.(true);
      this.pushThread();
    } else {
      vscode.commands.executeCommand(`${ConversationViewProvider.viewId}.focus`);
      setTimeout(() => this.pushThread(), 400);
    }
  }

  private async openFile(path: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, path));
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    } catch {
      vscode.window.showWarningMessage(`File not found in workspace: ${path}`);
    }
  }

  private pushThread(): void {
    if (!this.view || !this.pr || !this.thread) return;
    const t = this.thread;
    const root = t.comments[0];
    this.view.webview.postMessage({
      command: 'setThread',
      title: `[#${this.pr.number}] ${this.pr.title}`,
      subtitle: t.title,
      // A generated fix only makes sense for code review threads.
      canFix: t.kind === 'review' && !!root?.path && !t.isResolved,
      diffHtml:
        t.kind === 'review' && root?.diff_hunk
          ? `<pre class="diff"><code>${diffHtml(lastLines(root.diff_hunk, 8))}</code></pre>`
          : '',
      comments: t.comments.map((c: Comment) => ({
        author: '@' + c.user.login,
        date: new Date(c.created_at).toLocaleString(),
        html: renderMarkdown(c.body),
      })),
    });
  }

  private threadContext(): string {
    if (!this.pr || !this.thread) return '';
    const t = this.thread;
    const root = t.comments[0];
    const lines = [
      `You are assisting with GitHub pull request #${this.pr.number}: "${this.pr.title}"`,
      `Branch: ${this.pr.head.ref} -> ${this.pr.base.ref}`,
      this.pr.body ? `PR description:\n${this.pr.body}\n` : '',
      `--- Conversation thread (${t.title}) ---`,
    ];
    if (t.kind === 'review' && root?.path) {
      lines.push(`File: ${root.path}${root.line != null ? ` (line ${root.line})` : ''}`);
      if (root.diff_hunk) lines.push(`Diff context:\n${root.diff_hunk}`);
    }
    for (const c of t.comments) {
      lines.push(`@${c.user.login} (${c.created_at}):\n${c.body}\n`);
    }
    return lines.filter(Boolean).join('\n');
  }

  private async askClaude(userMessage: string, statusLabel: string | null): Promise<void> {
    if (!this.view) return;
    if (this.busy) {
      vscode.window.showWarningMessage('Claude is already working — wait or cancel first.');
      return;
    }

    this.busy = true;
    this.cancelSource = new vscode.CancellationTokenSource();
    const webview = this.view.webview;
    webview.postMessage({ command: 'claudeStart', label: statusLabel ?? userMessage });

    const transcript = this.chat
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Claude'}: ${turn.text}`)
      .join('\n\n');

    const contextBlock = this.contextItems.length
      ? this.contextItems
          .map((c, i) => `--- Context ${i + 1}: ${c.label} ---\n${c.content}`)
          .join('\n\n')
      : this.threadContext();

    const prompt = [
      contextBlock,
      transcript ? `--- Previous conversation with the user ---\n${transcript}` : '',
      `--- Request ---\n${userMessage}`,
      EDIT_FORMAT_INSTRUCTIONS,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const result = await runClaude(
        prompt,
        (e) => webview.postMessage({ command: 'claudeEvent', kind: e.type, text: e.text }),
        this.cancelSource.token
      );
      this.chat.push({ role: 'user', text: userMessage });
      this.chat.push({ role: 'claude', text: result });
      const rid = `r${this.responses.size}`;
      this.responses.set(rid, result);
      const edits = parseSuggestedEdits(result);
      webview.postMessage({
        command: 'claudeDone',
        rid,
        html: renderMarkdown(stripEditBlocks(result)),
        editsHtml: edits.length
          ? edits
              .map(
                (e) =>
                  `<div class="edit-block">` +
                  `<div class="edit-file"><span class="edit-path" title="${escapeHtml(e.file)}">${escapeHtml(e.file)}</span>` +
                  `<span class="spacer"></span>` +
                  `<button class="icon-btn" data-path="${escapeHtml(e.file)}" title="Open ${escapeHtml(e.file)} in editor">${FILE_ICON}</button></div>` +
                  (e.search
                    ? `<pre class="edit-old"><code>${escapeHtml(e.search)}</code></pre>`
                    : '<div class="muted small" style="padding:4px 8px">new file</div>') +
                  `<pre class="edit-new"><code>${escapeHtml(e.replace)}</code></pre>` +
                  `</div>`
              )
              .join('')
          : '',
        canApply: edits.length > 0,
      });
    } catch (err) {
      webview.postMessage({
        command: 'claudeError',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
      this.cancelSource = undefined;
    }
  }

  private async applyResponse(rid: string): Promise<void> {
    const raw = this.responses.get(rid) ?? '';
    const edits = parseSuggestedEdits(raw);
    if (edits.length === 0) {
      vscode.window.showInformationMessage('No applicable code suggestions in this response.');
      return;
    }
    try {
      const { applied, failed } = await applySuggestedEdits(edits);
      if (applied.length) {
        vscode.window.showInformationMessage(`Applied changes to: ${applied.join(', ')}`);
      }
      if (failed.length) {
        vscode.window.showWarningMessage(`Could not apply: ${failed.join(', ')}`);
      }
      this.view?.webview.postMessage({
        command: 'applyResult',
        rid,
        ok: failed.length === 0,
        applied,
        failed,
      });
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async postReply(text: string): Promise<void> {
    if (!this.pr || !this.thread || !this.view) return;
    try {
      const comment = await this.client.reply(this.pr.number, this.thread, text);
      this.thread.comments.push(comment);
      this.pushThread();
      this.view.webview.postMessage({ command: 'replyPosted' });
      vscode.window.showInformationMessage(`Reply posted to PR #${this.pr.number}.`);
      // Pull the latest PR data into the center panel.
      this.onReplied?.();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to post reply: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  private shellHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:;">
<style>
  :root { --border: var(--vscode-panel-border); --header-bg: var(--vscode-sideBar-background); --add-bg: #2da44e1f; --del-bg: #cf222e1f; --success: #238636; --danger: #da3633; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; display: flex; flex-direction: column; overflow: hidden; }
  button { border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-success { background: var(--success); color: #fff; font-weight: 600; }
  .btn-success:hover:not(:disabled) { background: #2ea043; }
  .btn-danger { background: var(--danger); color: #fff; font-weight: 600; }
  .btn-danger:hover:not(:disabled) { background: #f85149; }
  button:disabled { opacity: 0.45; cursor: default; }
  .icon-btn { background: none; color: var(--vscode-descriptionForeground); padding: 2px; display: inline-flex; align-items: center; border-radius: 4px; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px; font-family: var(--vscode-font-family); resize: vertical; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 11px; }
  .spacer { flex: 1; }

  #empty { margin-top: 24px; text-align: center; padding: 0 12px; }
  #content { display: none; flex: 1; min-height: 0; flex-direction: column; }
  #scrollArea { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 4px; }

  #title { font-weight: 600; margin-bottom: 2px; }
  #subtitle { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .comment { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
  .comment-meta { font-size: 11px; margin-bottom: 4px; display: flex; gap: 8px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 5px; overflow-x: auto; font-size: 11px; border: 1px solid var(--border); margin: 6px 0; }
  code { font-family: var(--vscode-editor-font-family); }
  .comment code, .claude-response code { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: 11px; }
  .comment pre code, .claude-response pre code { border: none; background: none; padding: 0; }
  pre.diff { border-left: 3px solid var(--vscode-charts-blue); }
  .line-add { display: block; background: var(--add-bg); }
  .line-del { display: block; background: var(--del-bg); }
  .line-hunk { display: block; color: var(--vscode-charts-blue); background: #316dca14; }

  .actions { display: flex; gap: 8px; margin: 10px 0; }
  #replyBox { display: none; margin-bottom: 10px; }
  #replyBox.visible { display: block; }
  .row { display: flex; gap: 8px; margin-top: 6px; justify-content: flex-end; }
  hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
  .activity { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0; }
  .activity::before { content: '⏳ '; }
  .claude-response { border: 1px solid var(--border); border-left: 3px solid var(--vscode-charts-purple); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
  .claude-user { border-left: 3px solid var(--vscode-charts-blue); border-radius: 6px; background: var(--vscode-textCodeBlock-background); padding: 6px 10px; margin: 8px 0; font-size: 12px; }

  /* suggested file changes: rows + uniform diff colors */
  .edit-block { border: 1px solid var(--border); border-radius: 6px; margin: 8px 0; overflow: hidden; }
  .edit-file { display: flex; align-items: center; gap: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 4px 8px; background: var(--header-bg); border-bottom: 1px solid var(--border); }
  .edit-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  pre.edit-old { background: var(--del-bg); margin: 0; border: none; border-radius: 0; border-bottom: 1px solid var(--border); }
  pre.edit-new { background: var(--add-bg); margin: 0; border: none; border-radius: 0; }

  .error { color: var(--vscode-errorForeground); font-size: 12px; margin: 6px 0; }
  .ok { color: #2da44e; font-size: 12px; margin: 6px 0; }

  /* applied files list */
  .apply-result { margin: 8px 0; }
  .apply-header { color: #2da44e; font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .apply-header.failed { color: var(--vscode-errorForeground); }
  .applied-row { display: flex; align-items: center; gap: 6px; color: var(--vscode-foreground); font-size: 12px; font-family: var(--vscode-editor-font-family); padding: 2px 0; }
  .applied-row .spacer { flex: 1; }

  /* stop button (left of Send) */
  .stop-btn { background: var(--danger); color: #fff; border-radius: 4px; padding: 5px 9px; display: inline-flex; align-items: center; }
  .stop-btn:hover { background: #f85149; }
  blockquote { border-left: 3px solid var(--border); margin: 4px 0; padding-left: 8px; color: var(--vscode-descriptionForeground); }

  /* chat box pinned at the bottom */
  #chatSection { flex-shrink: 0; border-top: 1px solid var(--border); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 8px 12px 10px; position: relative; }

  /* slash command autocomplete popup */
  #slashPopup { border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 -2px 10px rgba(0,0,0,0.28); max-height: 220px; overflow-y: auto; margin-bottom: 6px; }
  .slash-item { display: flex; align-items: baseline; gap: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
  .slash-item .scmd { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .slash-item .sdesc { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slash-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .slash-item.active .scmd, .slash-item.active .sdesc { color: var(--vscode-list-activeSelectionForeground); }
  .slash-hint { padding: 4px 10px; font-size: 10px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--border); }

  /* busy / typing animation */
  .busy { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); margin: 6px 0; }
  .busy .dots { display: inline-flex; gap: 3px; }
  .busy .dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--vscode-charts-purple); display: inline-block; animation: blink 1.2s infinite both; }
  .busy .dots i:nth-child(2) { animation-delay: 0.2s; }
  .busy .dots i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  .stream { white-space: pre-wrap; overflow-wrap: anywhere; }
  .stream .caret { display: inline-block; width: 7px; background: var(--vscode-charts-purple); animation: caret 1s steps(1) infinite; }
  @keyframes caret { 50% { opacity: 0; } }

  /* Claude context chips */
  .chat-toolbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .tool-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 11px; }
  .tool-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  #contextSection { margin-bottom: 10px; }
  .ctx-head { display: flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .ctx-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .ctx-chip { display: flex; align-items: center; gap: 6px; max-width: min-content; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 3px 6px 3px 8px; font-size: 11px; }
  .ctx-chip .ctx-icon { color: var(--vscode-charts-purple); opacity: 0.8; display: inline-flex; flex-shrink: 0; }
  .ctx-chip .ctx-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
  <div id="empty" class="muted">Add a comment or review to Claude's context from the center panel, or just start chatting below.</div>

  <div id="content">
    <div id="scrollArea">
      <div id="contextSection" style="display:none">
        <div class="ctx-head">
          <span>Claude context</span>
          <span class="spacer"></span>
          <button class="icon-btn" id="ctxClear" title="Clear all context">Clear</button>
        </div>
        <div class="ctx-chips" id="ctxChips"></div>
      </div>
      <div id="title"></div>
      <div id="subtitle"></div>
      <div id="diff"></div>
      <div id="comments"></div>

      <div class="actions" id="actions" style="display:none">
        <button id="btnFix" class="btn-secondary" title="Ask Claude to generate a fix for the attached context">⚡ Generate</button>
        <button id="btnReply" class="btn-secondary" title="Write a reply to post on GitHub">💬 Reply</button>
      </div>

      <div id="replyBox">
        <textarea id="replyText" rows="3" placeholder="Write a reply to post on GitHub…"></textarea>
        <div class="row">
          <button id="btnGenReply" class="btn-secondary" title="Draft a reply with Claude and put it in the box">✨ Generate reply</button>
          <button id="btnPostReply" class="btn-success" title="Post this reply to GitHub">Post reply to GitHub</button>
        </div>
      </div>

      <hr>
      <div class="muted small" style="text-transform:uppercase;letter-spacing:0.04em">Claude</div>
      <div id="claudeLog"></div>
    </div>

    <div id="chatSection">
      <div id="slashPopup" style="display:none"></div>
      <textarea id="chatText" rows="3" placeholder="Ask Claude about this conversation… (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="chat-toolbar">
        <button class="tool-btn" id="btnUpload" title="Upload a file or folder to Claude's context">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4-4a.75.75 0 0 1 1.06 0l4 4a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L8.75 5.06v6.19a.75.75 0 0 1-1.5 0V5.06L4.53 7.78a.75.75 0 0 1-1.06 0Z"/><path d="M2.75 14a.75.75 0 0 1 0-1.5h10.5a.75.75 0 0 1 0 1.5Z"/></svg>
          <span>Upload</span>
        </button>
        <button class="tool-btn" id="btnSlash" title="Insert a Claude slash command">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.875 2.27 5.09 13.61a.75.75 0 0 1-1.38-.583L8.494 1.687a.75.75 0 0 1 1.381.583Z"/></svg>
          <span>/ Commands</span>
        </button>
        <span class="spacer"></span>
        <button id="btnCancel" class="stop-btn" style="display:none" title="Stop the running Claude request"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg></button>
        <button id="btnSend" class="btn-primary" title="Send to Claude">Send</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let busy = false;
  let activityGroup = null;
  let busyEl = null;
  let streamEl = null;
  let streamText = '';

  function setBusy(value) {
    busy = value;
    ['btnFix', 'btnSend', 'btnPostReply', 'btnGenReply'].forEach((id) => ($(id).disabled = value));
    $('btnCancel').style.display = value ? '' : 'none';
  }

  function append(el) {
    $('claudeLog').appendChild(el);
    el.scrollIntoView({ block: 'nearest' });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'clear': {
        // Keep the chat usable; just reset thread view + context.
        $('content').style.display = 'flex';
        $('empty').style.display = 'none';
        $('title').textContent = '';
        $('subtitle').textContent = '';
        $('diff').innerHTML = '';
        $('comments').innerHTML = '';
        $('actions').style.display = 'none';
        $('contextSection').style.display = 'none';
        $('ctxChips').innerHTML = '';
        $('claudeLog').innerHTML = '';
        $('replyBox').classList.remove('visible');
        break;
      }
      case 'insertChat': {
        const box = $('chatText');
        box.value = (box.value ? box.value.replace(/\\s*$/, ' ') : '') + msg.text;
        box.focus();
        break;
      }
      case 'setContext': {
        $('content').style.display = 'flex';
        $('empty').style.display = 'none';
        const chips = $('ctxChips');
        // Generate + Reply only appear once there is context.
        $('actions').style.display = msg.items.length ? 'flex' : 'none';
        if (!msg.items.length) {
          $('contextSection').style.display = 'none';
          chips.innerHTML = '';
          break;
        }
        $('contextSection').style.display = '';
        const SPARK = '<svg class="spark" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1 6.7 4.7 3 6l3.7 1.3L8 11l1.3-3.7L13 6 9.3 4.7 8 1Z"/></svg>';
        chips.innerHTML = msg.items.map((label, i) =>
          '<div class="ctx-chip"><span class="ctx-icon">' + SPARK + '</span>' +
          '<span class="ctx-label" title="' + label.replace(/"/g, '&quot;') + '">' + label + '</span>' +
          '<button class="icon-btn ctx-remove" data-index="' + i + '" title="Remove from context">✕</button></div>'
        ).join('');
        break;
      }
      case 'setThread': {
        $('empty').style.display = 'none';
        $('content').style.display = 'flex';
        $('title').textContent = msg.title;
        $('subtitle').textContent = msg.subtitle;
        $('diff').innerHTML = msg.diffHtml || '';
        $('comments').innerHTML = msg.comments
          .map(
            (c) =>
              '<div class="comment"><div class="comment-meta"><strong>' +
              c.author +
              '</strong><span class="muted">' +
              c.date +
              '</span></div><div>' +
              c.html +
              '</div></div>'
          )
          .join('');
        $('claudeLog').innerHTML = '';
        $('replyBox').classList.remove('visible');
        break;
      }
      case 'claudeStart': {
        setBusy(true);
        const u = document.createElement('div');
        u.className = 'claude-user';
        u.textContent = msg.label;
        append(u);
        activityGroup = document.createElement('div');
        append(activityGroup);
        // Busy animation
        busyEl = document.createElement('div');
        busyEl.className = 'busy';
        busyEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>Claude is working…</span>';
        append(busyEl);
        // Live streaming output (actual Claude text)
        streamEl = document.createElement('div');
        streamEl.className = 'claude-response';
        streamEl.innerHTML = '<span class="stream"></span><span class="caret">&nbsp;</span>';
        streamText = '';
        append(streamEl);
        break;
      }
      case 'claudeEvent': {
        if (msg.kind === 'text' && streamEl) {
          streamText += msg.text;
          streamEl.querySelector('.stream').textContent = streamText;
          if (busyEl) busyEl.querySelector('span:last-child').textContent = 'Claude is responding…';
          streamEl.scrollIntoView({ block: 'nearest' });
        } else if (msg.kind === 'status' && activityGroup) {
          const d = document.createElement('div');
          d.className = 'activity';
          d.textContent = msg.text;
          activityGroup.appendChild(d);
          d.scrollIntoView({ block: 'nearest' });
        }
        break;
      }
      case 'claudeDone': {
        setBusy(false);
        if (activityGroup) activityGroup.innerHTML = '';
        if (busyEl) { busyEl.remove(); busyEl = null; }
        // No rendered content (e.g. reply draft routed to the box) — drop the bubble.
        if (!msg.html && !msg.editsHtml) {
          if (streamEl) { streamEl.remove(); streamEl = null; }
          break;
        }
        // Finalize: replace the live stream element with rendered markdown.
        const d = streamEl || document.createElement('div');
        streamEl = null;
        d.className = 'claude-response';
        d.innerHTML = msg.html + (msg.editsHtml || '');
        if (msg.canApply) {
          const row = document.createElement('div');
          row.className = 'row';
          const discard = document.createElement('button');
          discard.className = 'btn-danger';
          discard.textContent = 'Discard';
          discard.title = 'Discard these suggested changes';
          const apply = document.createElement('button');
          apply.className = 'btn-success';
          apply.textContent = '✓ Apply suggested changes';
          apply.title = 'Apply these changes to your working tree';
          apply.dataset.rid = msg.rid;
          apply.addEventListener('click', () => {
            vscode.postMessage({ command: 'applySuggestion', rid: msg.rid });
            row.remove();
          });
          discard.addEventListener('click', () => {
            row.remove();
          });
          row.appendChild(discard);
          row.appendChild(apply);
          d.appendChild(row);
        }
        append(d);
        break;
      }
      case 'claudeError': {
        setBusy(false);
        if (busyEl) { busyEl.remove(); busyEl = null; }
        if (streamEl && !streamText) { streamEl.remove(); }
        streamEl = null;
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = msg.text;
        append(d);
        break;
      }
      case 'applyResult': {
        const FILE_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';
        const d = document.createElement('div');
        d.className = 'apply-result';
        let html = '';
        if (msg.applied && msg.applied.length) {
          html += '<div class="apply-header">Applied</div>';
          html += msg.applied.map((f) =>
            '<div class="applied-row"><span>' + f + '</span><span class="spacer"></span>' +
            '<button class="icon-btn" data-path="' + f + '" title="Open ' + f + ' in editor">' + FILE_SVG + '</button></div>'
          ).join('');
        }
        if (msg.failed && msg.failed.length) {
          html += '<div class="apply-header failed">Failed</div>';
          html += msg.failed.map((f) => '<div class="applied-row"><span>' + f + '</span></div>').join('');
        }
        d.innerHTML = html;
        append(d);
        break;
      }
      case 'replyPosted': {
        $('replyText').value = '';
        $('replyBox').classList.remove('visible');
        break;
      }
      case 'replyDraft': {
        $('replyBox').classList.add('visible');
        $('replyText').value = msg.text;
        $('replyText').focus();
        break;
      }
      case 'slashList': {
        slashList = msg.items || [];
        break;
      }
      case 'openSlash': {
        const box = $('chatText');
        if (!/(^|\\s)\\/[\\w:-]*$/.test(box.value)) {
          box.value = (box.value ? box.value.replace(/\\s*$/, ' ') : '') + '/';
        }
        box.focus();
        updateSlash();
        break;
      }
    }
  });

  $('btnFix').addEventListener('click', () => {
    if (!busy) vscode.postMessage({ command: 'generateFix' });
  });
  $('btnReply').addEventListener('click', () => $('replyBox').classList.toggle('visible'));
  $('btnGenReply').addEventListener('click', () => {
    if (!busy) vscode.postMessage({ command: 'generateReply' });
  });
  $('btnPostReply').addEventListener('click', () => {
    const text = $('replyText').value;
    if (text.trim()) vscode.postMessage({ command: 'reply', text });
  });
  $('btnCancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  $('btnUpload').addEventListener('click', () => vscode.postMessage({ command: 'upload' }));
  $('btnSlash').addEventListener('click', () => vscode.postMessage({ command: 'slashCommands' }));

  function sendChat() {
    const text = $('chatText').value;
    if (!text.trim() || busy) return;
    $('chatText').value = '';
    closeSlash();
    vscode.postMessage({ command: 'chat', text });
  }
  $('btnSend').addEventListener('click', sendChat);

  // ---- Slash command autocomplete ----
  let slashList = [];
  let slashMatches = [];
  let slashActive = 0;
  const popup = $('slashPopup');

  // Returns the trailing "/token" being typed, or null.
  function slashToken() {
    const box = $('chatText');
    if (box.selectionStart !== box.value.length) return null;
    const m = box.value.match(/(?:^|\\s)(\\/[\\w:-]*)$/);
    return m ? m[1] : null;
  }

  function renderSlash() {
    if (!slashMatches.length) { closeSlash(); return; }
    popup.innerHTML =
      slashMatches.map((c, i) =>
        '<div class="slash-item' + (i === slashActive ? ' active' : '') + '" data-i="' + i + '">' +
        '<span class="scmd">' + c.label + '</span>' +
        (c.description ? '<span class="sdesc">' + c.description.replace(/</g, '&lt;') + '</span>' : '') +
        '</div>'
      ).join('') +
      '<div class="slash-hint">↑↓ navigate · Tab to select · Esc to dismiss</div>';
    popup.style.display = '';
    const active = popup.querySelector('.slash-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function updateSlash() {
    const token = slashToken();
    if (token == null) { closeSlash(); return; }
    const q = token.slice(1).toLowerCase();
    slashMatches = slashList.filter((c) => c.label.slice(1).toLowerCase().startsWith(q));
    slashActive = 0;
    renderSlash();
  }

  function closeSlash() {
    popup.style.display = 'none';
    slashMatches = [];
  }

  function selectSlash(i) {
    const choice = slashMatches[i];
    if (!choice) return;
    const box = $('chatText');
    box.value = box.value.replace(/(\\/[\\w:-]*)$/, choice.label + ' ');
    closeSlash();
    box.focus();
  }

  popup.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.slash-item');
    if (item) { e.preventDefault(); selectSlash(Number(item.dataset.i)); }
  });

  $('chatText').addEventListener('input', updateSlash);
  $('chatText').addEventListener('keydown', (e) => {
    const open = popup.style.display !== 'none' && slashMatches.length;
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = (slashActive + 1) % slashMatches.length; renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = (slashActive - 1 + slashMatches.length) % slashMatches.length; renderSlash(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); selectSlash(slashActive); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $('ctxClear').addEventListener('click', () => vscode.postMessage({ command: 'clearContext' }));

  document.addEventListener('click', (e) => {
    const rm = e.target.closest('.ctx-remove');
    if (rm) {
      vscode.postMessage({ command: 'removeContext', index: Number(rm.dataset.index) });
      return;
    }
    const fileBtn = e.target.closest('[data-path]');
    if (fileBtn) {
      vscode.postMessage({ command: 'openFile', path: fileBtn.dataset.path });
      return;
    }
    const link = e.target.closest('a[href]');
    if (link) {
      e.preventDefault();
      vscode.postMessage({ command: 'openExternal', url: link.href });
    }
  });

  // Chat is always available, even before any context is added.
  $('content').style.display = 'flex';
  $('empty').style.display = 'none';
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function diffHtml(hunk: string): string {
  return hunk
    .split('\n')
    .map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith('+')) return `<span class="line-add">${esc}</span>`;
      if (line.startsWith('-')) return `<span class="line-del">${esc}</span>`;
      if (line.startsWith('@@')) return `<span class="line-hunk">${esc}</span>`;
      return `<span>${esc}</span>`;
    })
    .join('\n');
}

function stripEditBlocks(text: string): string {
  return text.replace(/<<<FILE:[\s\S]*?>>>END/g, '*(code change shown below)*').trim();
}
