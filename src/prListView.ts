import * as vscode from 'vscode';
import { exec } from 'child_process';
import { GitHubClient, PullRequest, PrStatus, prStatus } from './github';
import { escapeHtml } from './markdown';

interface GitState {
  branch?: string;
  dirty: boolean;
  ahead: number;
}

function computeGitState(): Promise<GitState> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return Promise.resolve({ dirty: false, ahead: 0 });
  return new Promise((resolve) => {
    exec('git status --porcelain=v1 --branch', { cwd }, (err, stdout) => {
      if (err) {
        resolve({ dirty: false, ahead: 0 });
        return;
      }
      const lines = stdout.split('\n');
      const header = lines[0] ?? '';
      const branchMatch = header.match(/^## (?:No commits yet on )?([^.\s]+)/);
      const aheadMatch = header.match(/ahead (\d+)/);
      const dirty = lines.slice(1).some((l) => l.trim().length > 0);
      resolve({
        branch: branchMatch?.[1],
        dirty,
        ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
      });
    });
  });
}

type SortKey = 'newest' | 'oldest' | 'updated' | 'title';

interface FilterState {
  status: 'all' | PrStatus;
  label?: string;
  author?: string;
  assignee?: string;
  text?: string;
}

const STATUS_COLOR: Record<PrStatus, string> = {
  open: '#2da44e',
  draft: '#6e7781',
  merged: '#8250df',
  closed: '#cf222e',
};

export class PrListViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'prManager.prList';

  private view?: vscode.WebviewView;
  private prs: PullRequest[] = [];
  private error?: string;
  private loading = false;
  private filter: FilterState = { status: 'all' };
  private sort: SortKey = 'newest';
  private pendingTitle?: string;
  private selected?: number;
  private gitState: GitState = { dirty: false, ahead: 0 };

  constructor(private readonly client: GitHubClient) {}

  /** Recompute git working-tree state and re-render indicators. */
  async refreshGitState(): Promise<void> {
    this.gitState = await computeGitState();
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    if (this.pendingTitle) view.title = this.pendingTitle;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.shellHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'ready') {
        if (this.pendingTitle) this.post({ command: 'header', name: this.pendingTitle });
        void this.load();
      } else if (msg.command === 'open' && typeof msg.number === 'number') {
        const pr = this.prs.find((p) => p.number === msg.number);
        if (pr) {
          this.selected = pr.number;
          void vscode.commands.executeCommand('prManager.openPr', pr);
        }
      } else if (msg.command === 'refresh') {
        this.refresh();
      }
    });
  }

  setTitle(title: string): void {
    this.pendingTitle = title;
    if (this.view) {
      this.view.title = title;
      this.post({ command: 'header', name: title });
    }
  }

  refresh(): void {
    void this.load(true);
  }

  private async load(force = false): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.post({ command: 'loading' });
    try {
      if (force || this.prs.length === 0) {
        this.prs = await this.client.listPullRequests();
      }
      this.gitState = await computeGitState();
      this.error = undefined;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private render(): void {
    if (this.error) {
      this.post({ command: 'error', text: this.error });
      return;
    }
    const visible = this.applyFilterAndSort(this.prs);
    this.post({
      command: 'data',
      selected: this.selected ?? null,
      filtered: this.hasActiveFilter(),
      rows: visible.map((pr) => {
        const status = prStatus(pr);
        const assignee = pr.assignees[0];
        const onThisBranch = !!this.gitState.branch && pr.head.ref === this.gitState.branch;
        const indicator =
          onThisBranch && this.gitState.dirty
            ? 'uncommitted changes'
            : onThisBranch && this.gitState.ahead > 0
              ? `${this.gitState.ahead} unpushed commit${this.gitState.ahead > 1 ? 's' : ''}`
              : '';
        return {
          number: pr.number,
          titleText: escapeHtml(pr.title),
          labels: pr.labels.map((l) => ({ name: escapeHtml(l.name), color: l.color })),
          assignee: assignee
            ? {
                login: escapeHtml(assignee.login),
                avatar: assignee.avatar_url
                  ? `${assignee.avatar_url}${assignee.avatar_url.includes('?') ? '&' : '?'}s=36`
                  : '',
              }
            : null,
          status,
          statusColor: STATUS_COLOR[status],
          indicator,
        };
      }),
    });
  }

  private hasActiveFilter(): boolean {
    const f = this.filter;
    return f.status !== 'all' || !!f.label || !!f.author || !!f.assignee || !!f.text;
  }

  private applyFilterAndSort(prs: PullRequest[]): PullRequest[] {
    const f = this.filter;
    let out = prs.filter((pr) => {
      if (f.status !== 'all' && prStatus(pr) !== f.status) return false;
      if (f.label && !pr.labels.some((l) => l.name === f.label)) return false;
      if (f.author && pr.user.login !== f.author) return false;
      if (f.assignee && !pr.assignees.some((a) => a.login === f.assignee)) return false;
      if (f.text) {
        const needle = f.text.toLowerCase();
        if (
          !pr.title.toLowerCase().includes(needle) &&
          !String(pr.number).includes(needle) &&
          !(pr.body ?? '').toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
    switch (this.sort) {
      case 'newest':
        out = out.sort((a, b) => b.created_at.localeCompare(a.created_at));
        break;
      case 'oldest':
        out = out.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case 'updated':
        out = out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        break;
      case 'title':
        out = out.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return out;
  }

  async pickSort(): Promise<void> {
    const picks: Array<vscode.QuickPickItem & { key: SortKey }> = [
      { label: 'Newest first', key: 'newest' },
      { label: 'Oldest first', key: 'oldest' },
      { label: 'Recently updated', key: 'updated' },
      { label: 'Title (A–Z)', key: 'title' },
    ];
    picks.forEach((p) => (p.description = p.key === this.sort ? 'current' : undefined));
    const choice = await vscode.window.showQuickPick(picks, { title: 'Sort pull requests' });
    if (choice) {
      this.sort = choice.key;
      this.render();
    }
  }

  async pickFilter(): Promise<void> {
    const facet = await vscode.window.showQuickPick(
      [
        { label: '$(pulse) Status', id: 'status' },
        { label: '$(tag) Label', id: 'label' },
        { label: '$(account) Author', id: 'author' },
        { label: '$(person) Assignee', id: 'assignee' },
        { label: '$(search) Text search', id: 'text' },
        { label: '$(clear-all) Clear all filters', id: 'clear' },
      ],
      { title: 'Filter pull requests' }
    );
    if (!facet) return;

    switch (facet.id) {
      case 'clear':
        this.filter = { status: 'all' };
        break;
      case 'status': {
        const s = await vscode.window.showQuickPick(['all', 'open', 'draft', 'merged', 'closed'], {
          title: 'Filter by status',
        });
        if (s === undefined) return;
        this.filter.status = s as FilterState['status'];
        break;
      }
      case 'label': {
        const labels = [...new Set(this.prs.flatMap((p) => p.labels.map((l) => l.name)))].sort();
        const l = await vscode.window.showQuickPick(['(any)', ...labels], {
          title: 'Filter by label',
        });
        if (l === undefined) return;
        this.filter.label = l === '(any)' ? undefined : l;
        break;
      }
      case 'author': {
        const authors = [...new Set(this.prs.map((p) => p.user.login))].sort();
        const a = await vscode.window.showQuickPick(['(any)', ...authors], {
          title: 'Filter by author',
        });
        if (a === undefined) return;
        this.filter.author = a === '(any)' ? undefined : a;
        break;
      }
      case 'assignee': {
        const assignees = [
          ...new Set(this.prs.flatMap((p) => p.assignees.map((a) => a.login))),
        ].sort();
        const a = await vscode.window.showQuickPick(['(any)', ...assignees], {
          title: 'Filter by assignee',
        });
        if (a === undefined) return;
        this.filter.assignee = a === '(any)' ? undefined : a;
        break;
      }
      case 'text': {
        const t = await vscode.window.showInputBox({
          title: 'Filter by text',
          prompt: 'Matches PR number, title, or description. Leave empty to clear.',
          value: this.filter.text ?? '',
        });
        if (t === undefined) return;
        this.filter.text = t || undefined;
        break;
      }
    }
    this.render();
  }

  private shellHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:;">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; font-size: 12px; }
  #header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
  #header .hdr-ico { display: inline-flex; color: var(--vscode-foreground); flex-shrink: 0; }
  #repoName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status { padding: 12px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .pr-avatar { position: relative; flex-shrink: 0; display: inline-flex; }
  .dirty-dot { position: absolute; top: -2px; right: -2px; width: 9px; height: 9px; border-radius: 50%; background: #d4a72c; border: 1.5px solid var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-num { color: var(--vscode-foreground); font-weight: 600; font-size: 12px; }
  .row.selected .pr-num { color: var(--vscode-list-activeSelectionForeground); }
  .pr-title { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .row.selected .pr-title { color: var(--vscode-list-activeSelectionForeground); opacity: 0.85; }
  .row-meta { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .chip { border-radius: 999px; padding: 0 6px; font-size: 9px; font-weight: 600; line-height: 14px; white-space: nowrap; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; display: block; }
  .avatar-fallback { width: 28px; height: 28px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 12px; display: flex; align-items: center; justify-content: center; }
  .err { color: var(--vscode-errorForeground); padding: 12px; }
</style>
</head>
<body>
  <div id="header">
    <span class="hdr-ico"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg></span>
    <span id="repoName">Pull Requests</span>
  </div>
  <div id="status">Loading pull requests…</div>
  <div id="list"></div>
<script>
  const vscode = acquireVsCodeApi();
  let selected = null;

  // GitHub octicons per PR status
  const PR_ICONS = {
    open: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
    merged: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>',
    closed: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>',
    draft: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM12 2.5a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Zm1.5 4.243a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>'
  };

  function textColor(hex) {
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1f2328' : '#ffffff';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    const status = document.getElementById('status');
    const list = document.getElementById('list');
    if (msg.command === 'header') {
      document.getElementById('repoName').textContent = msg.name;
      return;
    }
    if (msg.command === 'loading') {
      status.textContent = 'Loading pull requests…';
      status.style.display = '';
      return;
    }
    if (msg.command === 'error') {
      status.innerHTML = '<span class="err"></span>';
      status.querySelector('.err').textContent = msg.text;
      status.style.display = '';
      list.innerHTML = '';
      return;
    }
    if (msg.command !== 'data') return;
    selected = msg.selected;
    if (msg.rows.length === 0) {
      status.textContent = msg.filtered ? 'No PRs match the filter.' : 'No pull requests found.';
      status.style.display = '';
      list.innerHTML = '';
      return;
    }
    status.style.display = 'none';
    list.innerHTML = msg.rows.map((pr) => {
      // Order: labels, assignee, status
      const labels = pr.labels.slice(0, 3).map((l) =>
        '<span class="chip" style="background:#' + l.color + ';color:' + textColor(l.color) + '" title="' + l.name + '">' + l.name + '</span>'
      ).join('');
      const inner = pr.assignee
        ? (pr.assignee.avatar
            ? '<img class="avatar" src="' + pr.assignee.avatar + '" title="assignee: ' + pr.assignee.login + '">'
            : '<span class="avatar-fallback" title="assignee: ' + pr.assignee.login + '">' + pr.assignee.login.charAt(0).toUpperCase() + '</span>')
        : '<span class="avatar-fallback" title="unassigned">?</span>';
      const dot = pr.indicator ? '<span class="dirty-dot" title="' + pr.indicator + '"></span>' : '';
      const avatar = '<span class="pr-avatar">' + inner + dot + '</span>';
      const statusChip = '<span class="chip" style="background:' + pr.statusColor + ';color:#fff">' + pr.status + '</span>';
      return '<div class="row' + (selected === pr.number ? ' selected' : '') + '" data-number="' + pr.number + '">' +
        avatar +
        '<span class="row-title" title="[#' + pr.number + '] ' + pr.titleText + '">' +
          '<span class="pr-num">[#' + pr.number + ']</span> <span class="pr-title">' + pr.titleText + '</span>' +
        '</span>' +
        '<span class="row-meta">' + labels + statusChip + '</span>' +
        '</div>';
    }).join('');
  });

  document.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    vscode.postMessage({ command: 'open', number: Number(row.dataset.number) });
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
