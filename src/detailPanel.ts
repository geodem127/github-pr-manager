import * as vscode from "vscode";
import {exec, execFile} from "child_process";
import {GitHubClient, PullRequest, PrDetail, Thread, Comment, ReviewerInfo, ChangedFile, prStatus} from "./github";
import {escapeHtml, renderMarkdown} from "./markdown";

const STATUS_COLOR: Record<string, string> = {
	open: "#2da44e",
	draft: "#6e7781",
	merged: "#8250df",
	closed: "#cf222e",
};

/** GitHub octicons (16px, fill=currentColor) */
const ICONS = {
	link: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"/></svg>',
	external: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>',
	file: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>',
	sync: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>',
	check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>',
	xCircle: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/></svg>',
	alert: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
	blocked: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8c0 1.42.457 2.733 1.232 3.8L11.8 2.732A6.47 6.47 0 0 0 8 1.5 6.5 6.5 0 0 0 1.5 8Zm12.232-3.8L4.2 13.268A6.471 6.471 0 0 0 8 14.5 6.5 6.5 0 0 0 14.5 8c0-1.42-.457-2.733-1.232-3.8Z"/></svg>',
	dot: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>',
	fileDiff: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H2.75a.25.25 0 0 0-.25.25v6a.75.75 0 0 1-1.5 0Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914ZM4.75 9.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5H5.5v1.5a.75.75 0 0 1-1.5 0v-1.5H2.5a.75.75 0 0 1 0-1.5H4V10a.75.75 0 0 1 .75-.75Z"/></svg>',
	comment: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/></svg>',
	issue: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>',
	chevron: '<svg class="chev" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>',
	branch: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>',
	// Claude sparkle with an arrow pointing into it — "add to Claude context"
	claudeAdd: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1.6 8.4 4.3 5.7 5.4l2.7 1.1 1.1 2.7 1.1-2.7 2.7-1.1-2.7-1.1L9.5 1.6Z"/><path d="M3.25 10.5h4.19l-1.22-1.22a.75.75 0 1 1 1.06-1.06l2.5 2.5a.75.75 0 0 1 0 1.06l-2.5 2.5a.75.75 0 1 1-1.06-1.06l1.22-1.22H3.25a.75.75 0 0 1 0-1.5Z"/></svg>',
};

interface Callbacks {
	onOpenThread: (pr: PullRequest, thread: Thread) => void;
	/** Add a comment/review to the Claude chat's context (with an optional reply target). */
	onAddContext: (
		label: string,
		content: string,
		target?: { pr: PullRequest; thread: Thread }
	) => void;
	/** Check out the PR's head branch (handles a dirty working tree). */
	onCheckout: (pr: PullRequest) => void | Promise<void>;
}

interface Suggestion {
	path: string;
	line: number | null;
	suggestion: string;
	old?: string;
}

interface DiffCell {
	num: number | null;
	text: string;
	type: "add" | "del" | "ctx" | "empty";
}

export class PrDetailPanel {
	private static current?: PrDetailPanel;

	private pr?: PullRequest;
	private detail?: PrDetail;
	private repoFull = "";
	private openFileIcon = "";
	private clawdIcon = "";
	private suggestions = new Map<string, Suggestion>();
	private canUpdateBranch = false;

	/** Loads an SVG from media, normalising it to a 14px currentColor icon. */
	private async loadIcon(file: string, fallback: string): Promise<string> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, "media", file));
			return Buffer.from(bytes)
				.toString("utf8")
				.replace(/<\?xml[^>]*\?>/, "")
				.replace(/\s(width|height)="[^"]*"/g, "")
				.replace("<svg ", '<svg fill="currentColor" width="14" height="14" ')
				.trim();
		} catch {
			return fallback;
		}
	}

	/** Refresh the currently open detail panel (e.g. after a reply from the right panel). */
	static refreshCurrent(): void {
		const p = PrDetailPanel.current;
		if (p?.pr) void p.load(p.pr);
	}

	static async show(extensionUri: vscode.Uri, client: GitHubClient, pr: PullRequest, callbacks: Callbacks): Promise<void> {
		if (!PrDetailPanel.current) {
			const panel = vscode.window.createWebviewPanel("prManager.detail", `PR #${pr.number}`, vscode.ViewColumn.One, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
			});
			PrDetailPanel.current = new PrDetailPanel(panel, extensionUri, client, callbacks);
		} else {
			PrDetailPanel.current.callbacks = callbacks;
			PrDetailPanel.current.panel.reveal(vscode.ViewColumn.One);
		}
		await PrDetailPanel.current.load(pr);
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly client: GitHubClient,
		private callbacks: Callbacks,
	) {
		panel.onDidDispose(() => {
			if (PrDetailPanel.current === this) PrDetailPanel.current = undefined;
		});
		panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
	}

	// ---------- message handling ----------

	private async onMessage(msg: {command: string; threadId?: string; commentId?: string; url?: string; path?: string; line?: number; login?: string; sid?: string; text?: string}): Promise<void> {
		switch (msg.command) {
			case "addContext": {
				const thread = this.detail?.threads.find((t) => t.id === msg.threadId);
				if (thread && this.pr) {
					const comments = msg.commentId ? thread.comments.filter((c) => String(c.id) === msg.commentId) : thread.comments;
					const selected = comments.length > 0 ? comments : thread.comments;
					const author = selected[0]?.user.login ?? "unknown";
					const label = thread.kind === "review" ? `${thread.title} · @${author}` : `Comment by @${author}`;
					this.callbacks.onAddContext(label, this.contextText(thread, selected), {
						pr: this.pr,
						thread,
					});
				}
				break;
			}
			case "checkout":
				if (this.pr) await this.callbacks.onCheckout(this.pr);
				break;
			case "replyThread":
				if (msg.threadId && msg.text?.trim() && this.pr) {
					const thread = this.detail?.threads.find((t) => t.id === msg.threadId);
					if (thread) {
						await this.tryAction(() => this.client.reply(this.pr!.number, thread, msg.text!.trim()), "Reply posted", "Failed to post reply");
					}
				}
				break;
			case "copyLink":
				if (msg.url) {
					await vscode.env.clipboard.writeText(msg.url);
					vscode.window.setStatusBarMessage("Link copied to clipboard", 2500);
				}
				break;
			case "openFile":
				await this.openFile(msg.path, msg.line);
				break;
			case "resolveThread":
				if (msg.threadId && this.pr) {
					await this.tryAction(() => this.client.resolveThread(msg.threadId!), "Conversation resolved", "Failed to resolve");
				}
				break;
			case "reRequest":
				if (msg.login && this.pr) {
					await this.tryAction(() => this.client.reRequestReview(this.pr!.number, msg.login!), `Re-requested review from @${msg.login}`, "Failed to re-request review");
				}
				break;
			case "applySuggestion":
				if (msg.sid) await this.applySuggestion(msg.sid);
				break;
			case "updateBranch":
				await this.updateBranch();
				break;
			case "addComment":
				if (msg.text?.trim() && this.pr) {
					await this.tryAction(() => this.client.addIssueComment(this.pr!.number, msg.text!.trim()), "Comment posted", "Failed to post comment");
				}
				break;
			case "refresh":
				if (this.pr) await this.load(this.pr);
				break;
			case "openExternal":
				if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
				break;
		}
	}

	private async tryAction(action: () => Promise<unknown>, okMessage: string, errPrefix: string): Promise<void> {
		try {
			await action();
			vscode.window.setStatusBarMessage(okMessage, 2500);
			if (this.pr) await this.load(this.pr);
		} catch (err) {
			vscode.window.showErrorMessage(`${errPrefix}: ${err instanceof Error ? err.message : err}`);
		}
	}

	private async openFile(path?: string, line?: number): Promise<void> {
		if (!path) return;
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) return;
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, path));
			const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			if (line) {
				const pos = new vscode.Position(Math.max(0, line - 1), 0);
				editor.selection = new vscode.Selection(pos, pos);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
			}
		} catch {
			vscode.window.showWarningMessage(`File not found in workspace: ${path}`);
		}
	}

	private async applySuggestion(sid: string): Promise<void> {
		const s = this.suggestions.get(sid);
		if (!s || !s.path || s.line == null) {
			vscode.window.showWarningMessage("This suggestion cannot be applied automatically.");
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) return;
		try {
			const uri = vscode.Uri.joinPath(root, s.path);
			const doc = await vscode.workspace.openTextDocument(uri);
			const lineIdx = s.line - 1;
			if (lineIdx < 0 || lineIdx >= doc.lineCount) {
				vscode.window.showWarningMessage(`Line ${s.line} no longer exists in ${s.path}. Apply manually.`);
				return;
			}
			const target = doc.lineAt(lineIdx);
			if (s.old !== undefined && target.text !== s.old) {
				const pick = await vscode.window.showWarningMessage(`Line ${s.line} of ${s.path} has changed since the suggestion was made. Apply anyway?`, "Apply anyway", "Cancel");
				if (pick !== "Apply anyway") return;
			}
			const ws = new vscode.WorkspaceEdit();
			ws.replace(uri, target.range, s.suggestion);
			const ok = await vscode.workspace.applyEdit(ws);
			if (ok) {
				await doc.save();
				vscode.window.setStatusBarMessage(`Suggestion applied to ${s.path}:${s.line}`, 3000);
				await this.openFile(s.path, s.line);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to apply suggestion: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** Fetches the latest base branch and merges it into the PR branch. */
	private async updateBranch(): Promise<void> {
		if (!this.pr) return;
		const pr = this.pr;
		const gitExt = vscode.extensions.getExtension("vscode.git");
		const git = gitExt?.isActive ? gitExt.exports.getAPI(1) : (await gitExt?.activate())?.getAPI(1);
		const repo = git?.repositories[0];
		if (!repo) {
			vscode.window.showErrorMessage("No Git repository available.");
			return;
		}
		const head: string | undefined = repo.state.HEAD?.name;
		try {
			if (head !== pr.head.ref) {
				const pick = await vscode.window.showWarningMessage(`You are on "${head}", but this PR's branch is "${pr.head.ref}".`, "Checkout & Update", "Cancel");
				if (pick !== "Checkout & Update") return;
				await repo.checkout(pr.head.ref);
			}
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Updating ${pr.head.ref} from origin/${pr.base.ref}…`,
				},
				() => execShell(`git pull origin $(gh pr view --json baseRefName --jq '.baseRefName') --no-edit`),
			);
			vscode.window.setStatusBarMessage(`Merged origin/${pr.base.ref} into ${pr.head.ref}`, 4000);
			await this.load(pr);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/CONFLICT|Automatic merge failed/i.test(message)) {
				vscode.window.showWarningMessage(`Merge of origin/${pr.base.ref} into ${pr.head.ref} has conflicts — resolve them in the editor, then commit.`);
				await this.load(pr);
			} else if (/gh: command not found|'gh' is not recognized/i.test(message)) {
				vscode.window.showErrorMessage("GitHub CLI (gh) is required to update the branch. Install it from https://cli.github.com.");
			} else {
				vscode.window.showErrorMessage(`Failed to update branch: ${message}`);
			}
		}
	}

	// ---------- data loading ----------

	private async load(pr: PullRequest): Promise<void> {
		this.pr = pr;
		this.panel.title = `PR #${pr.number}`;
		await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Loading PR #${pr.number}…`}, async () => {
			if (!this.openFileIcon) {
				this.openFileIcon = await this.loadIcon("open-file.svg", ICONS.file);
				this.clawdIcon = await this.loadIcon("clawd.svg", ICONS.claudeAdd);
			}
			const [repo, detail, behindBase] = await Promise.all([this.client.getRepo(), this.client.getPrDetail(pr.number), computeBehindBase(pr.base.ref)]);
			this.repoFull = repo.full;
			this.detail = detail;
			this.behindBase = behindBase;
			// Update-branch is only offered when the PR branch is checked out locally.
			this.canUpdateBranch = false;
			try {
				const gitExt = vscode.extensions.getExtension("vscode.git");
				const git = gitExt?.isActive ? gitExt.exports.getAPI(1) : undefined;
				this.canUpdateBranch = git?.repositories[0]?.state.HEAD?.name === pr.head.ref;
			} catch {
				// git extension unavailable — keep the button hidden
			}
			this.panel.webview.html = this.html(pr, detail);
		});
	}

	// ---------- shared rendering helpers ----------

	private avatar(user: {login: string; avatar_url?: string}, size = 32): string {
		if (user.avatar_url) {
			const sep = user.avatar_url.includes("?") ? "&" : "?";
			return `<img class="avatar" style="width:${size}px;height:${size}px" src="${user.avatar_url}${sep}s=${size * 2}" title="@${escapeHtml(user.login)}">`;
		}
		return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px">${escapeHtml(user.login.charAt(0).toUpperCase())}</span>`;
	}

	/** Markdown + commit-sha chips + GitHub `suggestion` blocks. */
	private commentBody(c: Comment, thread?: Thread): string {
		const md = c.body.replace(/```suggestion\r?\n([\s\S]*?)```/g, (_m, sugg: string) => {
			const sid = `s${this.suggestions.size}`;
			this.suggestions.set(sid, {
				path: c.path ?? thread?.path ?? "",
				line: c.line ?? thread?.line ?? hunkTargetLine(c.diff_hunk),
				suggestion: sugg.replace(/\r?\n$/, ""),
				old: lastHunkLine(c.diff_hunk),
			});
			return `@@SUGG-${sid}@@`;
		});
		let html = renderMarkdown(md).replace(/\b([0-9a-f]{40})\b/g, (_m, sha: string) => `<span class="commit-ref">${sha.slice(0, 7)}</span>`);
		html = html.replace(/@@SUGG-(s\d+)@@/g, (_m, sid: string) => this.suggestionHtml(sid));
		return html;
	}

	private suggestionHtml(sid: string): string {
		const s = this.suggestions.get(sid);
		if (!s) return "";
		const applicable = !!s.path && s.line != null;
		const oldRow = s.old !== undefined ? `<tr class="sugg-del"><td class="sign">−</td><td><code>${escapeHtml(s.old)}</code></td></tr>` : "";
		const newRows = s.suggestion
			.split("\n")
			.map((l) => `<tr class="sugg-add"><td class="sign">+</td><td><code>${escapeHtml(l)}</code></td></tr>`)
			.join("");
		return `
    <div class="suggestion">
      <div class="suggestion-header">
        <span>Suggested change</span>
        <span class="spacer"></span>
        ${applicable ? `<button class="btn-success btn-small" data-action="applySuggestion" data-sid="${sid}" title="Apply this change to ${escapeHtml(s.path)}:${s.line} in your working tree">Apply suggestion</button>` : '<span class="muted small" title="Missing file/line context">not auto-applicable</span>'}
      </div>
      <table class="sugg-diff">${oldRow}${newRows}</table>
    </div>`;
	}

	private headerActions(threadId: string, url: string, commentId?: number): string {
		const commentAttr = commentId != null ? ` data-comment="${commentId}"` : "";
		return `<button class="icon-btn" data-action="copyLink" data-url="${escapeHtml(url)}" title="Copy link to this comment">${ICONS.link}</button>` + `<button class="icon-btn ctx-btn" data-action="addContext" data-thread="${escapeHtml(threadId)}"${commentAttr} title="Add this to Claude's context">${this.clawdIcon}</button>`;
	}

	/** Plain-text rendering of a thread (or selected comments) for the Claude context. */
	private contextText(thread: Thread, comments: Comment[]): string {
		const pr = this.pr!;
		const root = thread.comments[0];
		const lines = [`GitHub PR #${pr.number} (${this.repoFull}): "${pr.title}"`, `Branch: ${pr.head.ref} -> ${pr.base.ref}`, `${thread.kind === "review" ? "Review conversation" : "Discussion"}: ${thread.title}` + (thread.isOutdated ? " [outdated]" : "") + (thread.isResolved ? " [resolved]" : "")];
		if (thread.kind === "review" && root?.path) {
			lines.push(`File: ${root.path}${thread.line != null ? ` (line ${thread.line})` : ""}`);
			// Keep enough of the hunk for Claude to locate the code, but stay lean.
			if (root.diff_hunk) lines.push("Diff:\n" + lastLines(root.diff_hunk, 15));
		}
		for (const c of comments) {
			lines.push(`@${c.user.login} (${c.created_at}):\n${c.body}`);
		}
		return lines.join("\n");
	}

	private collapseBtn(): string {
		return `<button class="icon-btn toggle-btn" title="Collapse / expand">${ICONS.chevron}</button>`;
	}

	// ---------- conversation tab ----------

	private discussionHtml(thread: Thread): string {
		return thread.comments
			.map((c) => {
				const fstatus =
					c.reviewState === "APPROVED" ? "approved"
					: c.reviewState === "CHANGES_REQUESTED" ? "changes"
					: c.reviewState ? "commented"
					: "comment";
				const verdict = c.reviewState === "APPROVED" ? '<span class="chip chip-green">approved</span>' : c.reviewState === "CHANGES_REQUESTED" ? '<span class="chip chip-red">changes requested</span>' : c.reviewState ? '<span class="chip chip-grey">reviewed</span>' : "";
				// Only review verdicts (approve/changes/comment review) can be replied to;
				// plain PR comments don't get a per-item reply box.
				const reply = c.reviewState ? this.replyBoxHtml(thread.id) : "";
				return `
      <div class="timeline-item filter-item" data-fauthor="${escapeHtml(c.user.login)}" data-fstatus="${fstatus}" data-ftype="comment">
        ${this.avatar(c.user, 32)}
        <div class="bubble bubble-comment collapsible st-${fstatus}">
          <div class="bubble-header">
            ${this.collapseBtn()}
            <strong>${escapeHtml(c.user.login)}</strong>
            <span class="muted" title="${new Date(c.created_at).toLocaleString()}">commented ${timeAgo(c.created_at)}</span>
            ${verdict}
            <span class="spacer"></span>
            ${this.headerActions(thread.id, c.html_url, c.id)}
          </div>
          <div class="card-body">
            <div class="bubble-body">${this.commentBody(c)}</div>
            ${reply}
          </div>
        </div>
      </div>`;
			})
			.join("");
	}

	/** GitHub-style collapsed reply affordance that expands into a textarea. */
	private replyBoxHtml(threadId: string): string {
		return `
    <div class="reply" data-thread="${escapeHtml(threadId)}">
      <textarea class="reply-input" rows="1" placeholder="Reply…"></textarea>
      <div class="reply-actions">
        <button class="btn-success btn-small reply-submit">Reply</button>
      </div>
    </div>`;
	}

	/** Diff hunk with old/new line-number gutters (matches Files Changed styling). */
	private numberedHunkHtml(hunk: string, maxRows = 12): string {
		interface Row {
			o: string;
			n: string;
			text: string;
			cls: string;
		}
		const rows: Row[] = [];
		let o = 0;
		let nn = 0;
		for (const line of hunk.split("\n")) {
			const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (m) {
				o = parseInt(m[1], 10);
				nn = parseInt(m[2], 10);
				rows.push({o: "", n: "", text: line, cls: "hunk"});
				continue;
			}
			if (line.startsWith("\\")) continue;
			if (line.startsWith("-")) rows.push({o: String(o++), n: "", text: line.slice(1), cls: "del"});
			else if (line.startsWith("+")) rows.push({o: "", n: String(nn++), text: line.slice(1), cls: "add"});
			else rows.push({o: String(o++), n: String(nn++), text: line.slice(1), cls: "ctx"});
		}
		const shown = rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
		return '<table class="hunk-table">' + shown.map((r) => (r.cls === "hunk" ? `<tr class="hunk-row"><td colspan="3">${escapeHtml(r.text)}</td></tr>` : `<tr><td class="num">${r.o}</td><td class="num">${r.n}</td><td class="code ${r.cls}">${escapeHtml(r.text)}</td></tr>`)).join("") + "</table>";
	}

	private reviewThreadHtml(thread: Thread): string {
		const root = thread.comments[0];
		const hunk = root?.diff_hunk ? this.numberedHunkHtml(root.diff_hunk) : "";
		const comments = thread.comments
			.map(
				(c) => `
      <div class="thread-comment">
        ${this.avatar(c.user, 24)}
        <div class="thread-comment-main">
          <div class="thread-comment-meta">
            <strong>${escapeHtml(c.user.login)}</strong>
            <span class="muted" title="${new Date(c.created_at).toLocaleString()}">commented ${timeAgo(c.created_at)}</span>
          </div>
          <div class="bubble-body">${this.commentBody(c, thread)}</div>
        </div>
      </div>`,
			)
			.join("");

		const fstatus = thread.isResolved ? "resolved" : thread.isOutdated ? "outdated" : "unresolved";
		const author = root?.user.login ?? "unknown";
		return `
    <div class="timeline-item filter-item" data-fauthor="${escapeHtml(author)}" data-fstatus="${fstatus}" data-ftype="review">
    <div class="thread-card collapsible st-${fstatus} ${thread.isResolved ? "resolved" : ""}" data-container="${escapeHtml(thread.id)}">
      <div class="file-header">
        ${this.collapseBtn()}
        <span class="path">${escapeHtml(thread.title)}</span>
        ${thread.path ? `<button class="icon-btn" data-action="openFile" data-path="${escapeHtml(thread.path)}" data-line="${thread.line ?? ""}" title="Open ${escapeHtml(thread.path)}${thread.line != null ? ":" + thread.line : ""} in editor">${this.openFileIcon}</button>` : ""}
        ${thread.isOutdated ? '<span class="chip chip-yellow">Outdated</span>' : ""}
        ${thread.isResolved ? '<span class="chip chip-grey">Resolved</span>' : ""}
        <span class="spacer"></span>
        ${this.headerActions(thread.id, root?.html_url ?? "")}
      </div>
      <div class="card-body">
        ${hunk}
        ${comments}
        ${this.replyBoxHtml(thread.id)}
        <div class="thread-footer">
          ${thread.isResolved ? "" : `<button class="btn-success" data-action="resolveThread" data-thread="${escapeHtml(thread.id)}" title="Mark this conversation as resolved on GitHub">Resolve conversation</button>`}
        </div>
      </div>
    </div>
    </div>`;
	}

	private reviewerHtml(r: ReviewerInfo): string {
		const indicator = r.state === "APPROVED" ? `<span class="rev-ind green" title="Approved">${ICONS.check}</span>` : r.state === "CHANGES_REQUESTED" ? `<span class="rev-ind red" title="Requested changes">${ICONS.fileDiff}</span>` : r.state === "COMMENTED" ? `<span class="rev-ind grey" title="Commented">${ICONS.comment}</span>` : `<span class="rev-ind yellow" title="Awaiting review">${ICONS.dot}</span>`;
		const reRequest = r.state === "PENDING" ? "" : `<button class="icon-btn" data-action="reRequest" data-login="${escapeHtml(r.login)}" title="Re-request review from @${escapeHtml(r.login)}">${ICONS.sync}</button>`;
		return `
    <div class="side-row">
      ${this.avatar(r, 20)}
      <span class="side-name">${escapeHtml(r.login)}</span>
      <span class="spacer"></span>
      ${reRequest}
      ${indicator}
    </div>`;
	}

	private sidebarHtml(pr: PullRequest, detail: PrDetail): string {
		const reviewers = detail.reviewers.length ? detail.reviewers.map((r) => this.reviewerHtml(r)).join("") : '<div class="muted small">No reviews</div>';
		const assignees = pr.assignees.length ? pr.assignees.map((a) => `<div class="side-row">${this.avatar(a, 20)}<span class="side-name">${escapeHtml(a.login)}</span></div>`).join("") : '<div class="muted small">No one assigned</div>';
		const labelBase = `https://github.com/${this.repoFull}/pulls?q=${encodeURIComponent("is:pr")}`;
		const labels = pr.labels.length ? `<div class="label-wrap">${pr.labels.map((l) => `<a class="chip" href="${labelBase}+${encodeURIComponent('label:"' + l.name + '"')}" style="background:#${l.color}" data-color="${l.color}" title="Filter by ${escapeHtml(l.name)}">${escapeHtml(l.name)}</a>`).join("")}</div>` : '<div class="muted small">None yet</div>';
		const development = detail.linkedIssues.length ? detail.linkedIssues.map((i) => `<div class="side-row"><span class="rev-ind green">${ICONS.issue}</span><a href="${escapeHtml(i.url)}" class="side-name">#${i.number} ${escapeHtml(i.title)}</a></div>`).join("") : '<div class="muted small">No linked issues</div>';

		return `
    <aside class="sidebar">
      <section><h3>Reviewers</h3>${reviewers}</section>
      <section><h3>Assignees</h3>${assignees}</section>
      <section><h3>Labels</h3>${labels}</section>
      <section><h3>Development</h3>${development}</section>
    </aside>`;
	}

	/** Commits the local HEAD is behind origin/<base>; null when undeterminable. */
	private behindBase: number | null = null;

	private mergeBoxHtml(pr: PullRequest, detail: PrDetail): string {
		const approved = detail.reviewers.some((r) => r.state === "APPROVED");
		const review = detail.changesRequested ? row("red", ICONS.fileDiff, "Changes requested", "At least one reviewer requested changes.") : approved ? row("green", ICONS.check, "Changes approved", "Approving reviews are in place.") : row("grey", ICONS.dot, "Review required", "No approving reviews yet.");

		let checks: string;
		switch (detail.checksState) {
			case "SUCCESS":
				checks = row("green", ICONS.check, "All checks have passed", "");
				break;
			case "FAILURE":
			case "ERROR":
				checks = row("red", ICONS.xCircle, "Some checks were not successful", "");
				break;
			case "PENDING":
			case "EXPECTED":
				checks = row("yellow", ICONS.dot, "Some checks haven't completed yet", "");
				break;
			default:
				checks = row("grey", ICONS.dot, "No checks reported", "");
		}

		// Out-of-date basis: local checked-out branch vs the remote base (origin/<base>).
		let branch: string;
		if (this.behindBase != null && this.behindBase > 0) {
			branch = row("yellow", ICONS.alert, "This branch is out-of-date with the base branch", `Your local branch is ${this.behindBase} commit${this.behindBase > 1 ? "s" : ""} behind origin/${escapeHtml(pr.base.ref)}.` + (this.canUpdateBranch ? "" : " Check out the PR branch locally to enable updating."), this.canUpdateBranch ? `<button class="btn-primary" data-action="updateBranch" title="Fetch the latest base branch and merge it into the PR branch">Update branch</button>` : "");
		} else if (detail.mergeableState === "dirty") {
			branch = row("red", ICONS.blocked, "This branch has conflicts with the base branch", "");
		} else if (detail.mergeableState === "blocked") {
			branch = row("red", ICONS.blocked, "Merging is blocked", "Required conditions have not been met.");
		} else if (this.behindBase === 0) {
			branch = row("green", ICONS.check, `Up to date with origin/${escapeHtml(pr.base.ref)}`, "");
		} else if (detail.mergeableState === "clean") {
			branch = row("green", ICONS.check, "No conflicts with the base branch", "");
		} else {
			branch = row("grey", ICONS.dot, `Branch state: ${escapeHtml(detail.mergeableState)}`, "");
		}

		return `<div class="merge-box">${review}${checks}${branch}</div>`;

		function row(color: string, icon: string, title: string, sub: string, action = ""): string {
			return `
      <div class="merge-row">
        <span class="rev-ind ${color}">${icon}</span>
        <div><strong>${title}</strong>${sub ? `<div class="muted small">${sub}</div>` : ""}</div>
        <span class="spacer"></span>
        ${action}
      </div>`;
		}
	}

	private addCommentHtml(): string {
		return `
    <div class="add-comment">
      <h2 class="section">Add a comment</h2>
      <textarea id="newComment" rows="4" placeholder="Leave a comment"></textarea>
      <div class="row-right">
        <button class="btn-success" id="btnComment" title="Post this comment to the pull request">Comment</button>
      </div>
    </div>`;
	}

	// ---------- files changed tab ----------

	private filesHtml(files: ChangedFile[], threads: Thread[]): string {
		if (files.length === 0) return '<p class="muted">No changed files.</p>';
		return files
			.map((f) => {
				const fileThreads = threads.filter((t) => t.kind === "review" && t.path === f.filename && t.line != null);
				const letter = f.status === "added" ? '<span class="fstat fadd">A</span>' : f.status === "removed" ? '<span class="fstat fdel">D</span>' : f.status === "renamed" ? '<span class="fstat fren">R</span>' : '<span class="fstat fmod">M</span>';
				const body = f.patch ? this.splitDiffHtml(f.patch, fileThreads) : '<div class="muted small" style="padding:8px 12px">No diff available (binary or too large).</div>';
				return `
      <div class="thread-card file-card collapsible">
        <div class="file-header">
          ${this.collapseBtn()}
          ${letter}
          <span class="path">${escapeHtml(f.filename)}</span>
          <button class="icon-btn" data-action="openFile" data-path="${escapeHtml(f.filename)}" title="Open ${escapeHtml(f.filename)} in editor">${this.openFileIcon}</button>
          <span class="spacer"></span>
          <span class="adds" title="${f.additions} additions">+${f.additions}</span>
          <span class="dels" title="${f.deletions} deletions">−${f.deletions}</span>
        </div>
        <div class="card-body file-body">${body}</div>
      </div>`;
			})
			.join("");
	}

	private splitDiffHtml(patch: string, threads: Thread[]): string {
		const byLine = new Map<number, Thread[]>();
		for (const t of threads) {
			if (t.line == null) continue;
			const list = byLine.get(t.line) ?? [];
			list.push(t);
			byLine.set(t.line, list);
		}

		const out: string[] = ['<table class="split">'];
		out.push('<colgroup><col class="c-num"><col><col class="c-num"><col></colgroup>');

		let oldN = 0;
		let newN = 0;
		let dels: DiffCell[] = [];
		let adds: DiffCell[] = [];

		const cell = (c: DiffCell): string => `<td class="num">${c.num ?? ""}</td><td class="code ${c.type}">${c.text ? escapeHtml(c.text) : c.type === "empty" ? "" : " "}</td>`;

		const emitComments = (line: number | null): void => {
			if (line == null) return;
			for (const t of byLine.get(line) ?? []) {
				out.push(`<tr class="inline-row"><td colspan="4">${this.inlineThreadHtml(t)}</td></tr>`);
			}
		};

		const flush = (): void => {
			const max = Math.max(dels.length, adds.length);
			for (let i = 0; i < max; i++) {
				const left = dels[i] ?? {num: null, text: "", type: "empty" as const};
				const right = adds[i] ?? {num: null, text: "", type: "empty" as const};
				out.push(`<tr>${cell(left)}${cell(right)}</tr>`);
				emitComments(right.num);
			}
			dels = [];
			adds = [];
		};

		for (const line of patch.split("\n")) {
			if (line.startsWith("@@")) {
				flush();
				const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
				if (m) {
					oldN = parseInt(m[1], 10);
					newN = parseInt(m[2], 10);
				}
				out.push(`<tr class="hunk-row"><td colspan="4">${escapeHtml(line)}</td></tr>`);
			} else if (line.startsWith("-")) {
				dels.push({num: oldN++, text: line.slice(1), type: "del"});
			} else if (line.startsWith("+")) {
				adds.push({num: newN++, text: line.slice(1), type: "add"});
			} else if (line.startsWith("\\")) {
				continue;
			} else {
				flush();
				const text = line.slice(1);
				out.push(`<tr>${cell({num: oldN++, text, type: "ctx"})}${cell({num: newN, text, type: "ctx"})}</tr>`);
				emitComments(newN);
				newN++;
			}
		}
		flush();
		out.push("</table>");
		return out.join("");
	}

	private inlineThreadHtml(thread: Thread): string {
		const comments = thread.comments
			.map(
				(c) => `
      <div class="thread-comment">
        ${this.avatar(c.user, 20)}
        <div class="thread-comment-main">
          <div class="thread-comment-meta">
            <strong>${escapeHtml(c.user.login)}</strong>
            <span class="muted" title="${new Date(c.created_at).toLocaleString()}">commented ${timeAgo(c.created_at)}</span>
            ${thread.isOutdated ? '<span class="chip chip-yellow">Outdated</span>' : ""}
            ${thread.isResolved ? '<span class="chip chip-grey">Resolved</span>' : ""}
          </div>
          <div class="bubble-body">${this.commentBody(c, thread)}</div>
        </div>
      </div>`,
			)
			.join("");
		const resolve = thread.isResolved ? "" : `<button class="btn-success btn-small" data-action="resolveThread" data-thread="${escapeHtml(thread.id)}" title="Mark this conversation as resolved on GitHub">Resolve conversation</button>`;
		const openFile = thread.path ? `<button class="icon-btn" data-action="openFile" data-path="${escapeHtml(thread.path)}" data-line="${thread.line ?? ""}" title="Open ${escapeHtml(thread.path)}${thread.line != null ? ":" + thread.line : ""} in editor">${this.openFileIcon}</button>` : "";
		return `
    <div class="inline-thread" data-container="${escapeHtml(thread.id)}">
      <div class="inline-thread-header">
        <span class="muted small">Review comment</span>
        <span class="spacer"></span>
        ${resolve}
        ${openFile}
        ${this.headerActions(thread.id, thread.comments[0]?.html_url ?? "")}
      </div>
      ${comments}
      ${this.replyBoxHtml(thread.id)}
    </div>`;
	}

	// ---------- page ----------

	private html(pr: PullRequest, detail: PrDetail): string {
		this.suggestions.clear();
		const status = prStatus(pr);
		const discussionThreads = detail.threads.filter((t) => t.kind === "discussion");
		const reviewThreads = detail.threads.filter((t) => t.kind === "review");

		const authors = [...new Set(detail.threads.flatMap((t) => t.comments.map((c) => c.user.login)))].sort();
		const authorOptions = authors.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
		const filterBar = detail.threads.length
			? `<div class="filter-bar">
           <span class="filter-title">Filter</span>
           <select id="fAuthor" title="Filter by author"><option value="all">All authors</option>${authorOptions}</select>
           <select id="fStatus" title="Filter by status">
             <option value="all">All statuses</option>
             <option value="approved">Approved</option>
             <option value="changes">Changes requested</option>
             <option value="commented">Commented</option>
             <option value="unresolved">Unresolved</option>
             <option value="resolved">Resolved</option>
             <option value="outdated">Outdated</option>
           </select>
           <select id="fType" title="Filter by type">
             <option value="all">All types</option>
             <option value="comment">Comments</option>
             <option value="review">Review conversations</option>
           </select>
           <span class="spacer"></span>
           <button class="btn-secondary btn-small" id="fClear">Clear</button>
         </div>
         <div id="filterEmpty" class="muted small" style="display:none;margin:10px 0">Nothing matches these filters.</div>`
			: "";

		const conversationHtml =
			filterBar +
			`
      <div class="timeline-item">
        ${this.avatar(pr.user, 32)}
        <div class="bubble bubble-description collapsible">
          <div class="bubble-header">
            ${this.collapseBtn()}
            <strong>${escapeHtml(pr.user.login)}</strong>
            <span class="muted" title="${new Date(pr.created_at).toLocaleString()}">opened this pull request ${timeAgo(pr.created_at)}</span>
          </div>
          <div class="card-body"><div class="bubble-body">${renderMarkdown(pr.body)}</div></div>
        </div>
      </div>` +
			discussionThreads.map((t) => this.discussionHtml(t)).join("") +
			(reviewThreads.length
				? `<h2 class="section">Review conversations</h2>` +
					reviewThreads.map((t) => this.reviewThreadHtml(t)).join("")
				: "") +
			this.mergeBoxHtml(pr, detail) +
			this.addCommentHtml();

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:;">
<style>
  :root { --border: var(--vscode-panel-border); --header-bg: var(--vscode-sideBar-background); --add-bg: #2da44e1f; --del-bg: #cf222e1f; --success: #238636; --danger: #da3633; --gh-accent: #1f6feb; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, var(--vscode-font-family), sans-serif; color: var(--vscode-foreground); padding: 0 20px 48px; max-width: 1280px; margin: 0 auto; font-size: 13px; }
  a.chip { text-decoration: none; }
  a.chip:hover { text-decoration: none; opacity: 0.85; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 11px; }
  .spacer { flex: 1; }
  .repo { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 14px; }
  h1 { font-size: 20px; margin: 4px 0 8px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
  .status { color: #fff; padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .branch { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .chip { border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .chip-green { background: #2da44e22; color: #2da44e; border: 1px solid #2da44e66; }
  .chip-red { background: #cf222e22; color: #e5534b; border: 1px solid #cf222e66; }
  .chip-yellow { background: #bf870022; color: #d4a72c; border: 1px solid #bf870066; }
  .chip-grey { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .tabs { display: flex; gap: 4px; align-items: center; border-bottom: 1px solid var(--border); margin: 14px 0 18px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 5; }
  .tab-actions { display: flex; align-items: center; gap: 6px; margin-right: 4px; }
  .tab-actions .btn-secondary { display: inline-flex; align-items: center; }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--vscode-foreground); padding: 8px 14px; cursor: pointer; font-size: 13px; }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .tab .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 999px; padding: 0 7px; font-size: 11px; margin-left: 4px; }

  .layout { display: flex; gap: 24px; align-items: flex-start; }
  .main { flex: 1; min-width: 0; }
  .sidebar { width: 240px; flex-shrink: 0; }
  .sidebar section { border-bottom: 1px solid var(--border); padding: 10px 0 12px; }
  .sidebar h3 { font-size: 12px; margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .side-row { display: flex; align-items: center; gap: 7px; padding: 3px 0; min-width: 0; }
  .side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label-wrap { display: flex; flex-wrap: wrap; gap: 4px; }

  .avatar { border-radius: 50%; flex-shrink: 0; }
  .avatar-fallback { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }

  .timeline-item { display: flex; gap: 12px; margin: 16px 0; }
  .bubble { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--vscode-editor-background); }
  .bubble-description { border-color: var(--vscode-focusBorder); }
  .bubble-header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--header-bg); border-bottom: 1px solid var(--border); font-size: 12px; }
  .bubble-body { padding: 4px 14px; overflow-wrap: anywhere; }

  /* collapsible + active highlight */
  .collapsible.collapsed .card-body { display: none; }
  .collapsible .chev { transform: rotate(90deg); transition: transform 0.12s ease; }
  .collapsible.collapsed .chev { transform: rotate(0deg); }
  .active-container { outline: 2px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* code styling */
  .bubble-body code, .thread-comment-main code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; font-size: 12px; }
  .bubble-body pre, .thread-comment-main pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  .bubble-body pre code, .thread-comment-main pre code { border: none; background: none; padding: 0; }

  .thread-card { border: 1px solid var(--border); border-radius: 8px; margin: 14px 0; overflow: hidden; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .thread-card.resolved { opacity: 0.8; }
  .file-header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--header-bg); border-bottom: 1px solid var(--border); }
  .path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .thread-comment { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .thread-comment:last-of-type { border-bottom: none; }
  .thread-comment-main { flex: 1; min-width: 0; }
  .thread-comment-meta { font-size: 12px; margin-bottom: 2px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .thread-footer { padding: 8px 12px; background: var(--header-bg); border-top: 1px solid var(--border); min-height: 10px; }

  .icon-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px; border-radius: 4px; display: inline-flex; align-items: center; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .btn-primary { background: var(--gh-accent); color: #fff; border: none; border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-primary:hover { background: #388bfd; }
  /* GitHub-style secondary button — adapts to light/dark via theme vars */
  .btn-secondary {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.12)));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-contrastBorder, var(--border));
    border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 500;
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.22))); }
  .btn-secondary svg { width: 14px; height: 14px; }
  .btn-success { background: var(--success); color: #fff; border: none; border-radius: 5px; padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-success:hover { background: #2ea043; }
  .btn-danger { background: var(--danger); color: #fff; border: none; border-radius: 5px; padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-danger:hover { background: #f85149; }
  .btn-small { padding: 2px 9px; font-size: 11px; }
  button:disabled { opacity: 0.5; cursor: default; }

  pre { font-size: 12px; margin: 0; }
  code { font-family: var(--vscode-editor-font-family); }
  .commit-ref { font-family: var(--vscode-editor-font-family); background: #316dca22; color: var(--vscode-textLink-foreground); border-radius: 4px; padding: 0 5px; font-size: 12px; }
  blockquote { border-left: 3px solid var(--border); margin: 4px 0; padding-left: 10px; color: var(--vscode-descriptionForeground); }

  /* suggested change */
  .suggestion { border: 1px solid var(--border); border-radius: 6px; margin: 10px 0; overflow: hidden; }
  .suggestion-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--header-bg); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; }
  .sugg-diff { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .sugg-diff td { padding: 2px 8px; white-space: pre-wrap; word-break: break-all; }
  .sugg-diff td.sign { width: 18px; text-align: center; user-select: none; }
  .sugg-diff code { border: none; background: none; padding: 0; }
  .sugg-del { background: var(--del-bg); }
  .sugg-del .sign { color: #e5534b; }
  .sugg-add { background: var(--add-bg); }
  .sugg-add .sign { color: #2da44e; }

  .rev-ind { display: inline-flex; }
  .rev-ind.green { color: #2da44e; }
  .rev-ind.red { color: #e5534b; }
  .rev-ind.yellow { color: #d4a72c; }
  .rev-ind.grey { color: var(--vscode-descriptionForeground); }

  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-top: 28px; }
  .section-row { display: flex; align-items: flex-end; gap: 8px; }
  .section-row h2.section { margin-bottom: 0; }
  .filter-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  #threadFilter { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--border)); border-radius: 4px; padding: 2px 6px; font-size: 12px; font-family: var(--vscode-font-family); }

  .merge-box { border: 1px solid var(--border); border-radius: 8px; margin-top: 24px; overflow: hidden; }
  .merge-row { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .merge-row:last-child { border-bottom: none; }

  .add-comment { margin-top: 24px; }
  .add-comment textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 8px; font-family: var(--vscode-font-family); font-size: 13px; resize: vertical; }
  .row-right { display: flex; justify-content: flex-end; margin-top: 8px; }

  /* numbered hunk table (conversation tab) */
  table.hunk-table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; border-bottom: 1px solid var(--border); }
  table.hunk-table td.num { width: 38px; text-align: right; padding: 1px 7px; color: var(--vscode-descriptionForeground); user-select: none; background: var(--header-bg); border-right: 1px solid var(--border); font-size: 11px; vertical-align: top; }
  table.hunk-table td.code { padding: 1px 8px; white-space: pre-wrap; word-break: break-all; }

  /* files changed: split diff */
  .file-card .file-body { overflow-x: auto; }
  table.split { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; table-layout: fixed; }
  col.c-num { width: 42px; }
  table.split td { vertical-align: top; }
  td.num { text-align: right; padding: 1px 7px; color: var(--vscode-descriptionForeground); user-select: none; background: var(--header-bg); border-right: 1px solid var(--border); font-size: 11px; }
  td.code { padding: 1px 8px; white-space: pre-wrap; word-break: break-all; }
  td.code.add { background: var(--add-bg); }
  td.code.del { background: var(--del-bg); }
  td.code.empty { background: var(--vscode-textCodeBlock-background); opacity: 0.45; }
  td.code:nth-of-type(2) { border-right: 1px solid var(--border); }
  .hunk-row td { color: var(--vscode-charts-blue); background: #316dca14; padding: 3px 10px; font-size: 11px; }
  .inline-row td { padding: 10px 14px; background: var(--vscode-list-hoverBackground, var(--header-bg)); }
  .inline-thread { border: 1px solid var(--vscode-focusBorder); border-radius: 8px; overflow: hidden; max-width: 760px; background: var(--vscode-editor-background); box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
  .inline-thread-header { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: var(--header-bg); border-bottom: 1px solid var(--border); }

  .fstat { font-weight: 700; font-size: 12px; width: 14px; text-align: center; }
  .fadd { color: #2da44e; } .fdel { color: #e5534b; } .fmod { color: #d4a72c; } .fren { color: var(--vscode-charts-blue); }
  .adds { color: #2da44e; font-size: 12px; } .dels { color: #e5534b; font-size: 12px; }

  /* status color coding (left accent) */
  .st-approved { border-left: 3px solid #2da44e; }
  .st-changes { border-left: 3px solid #e5534b; }
  .st-unresolved { border-left: 3px solid #d4a72c; }
  .st-outdated { border-left: 3px solid #d4a72c; }
  .st-resolved { border-left: 3px solid var(--vscode-descriptionForeground); }
  .st-comment { border-left: 3px solid var(--vscode-charts-blue); }
  .ctx-btn:hover { color: var(--vscode-charts-purple); }
  .ctx-btn.ctx-added { color: var(--vscode-charts-purple); background: var(--vscode-toolbar-hoverBackground); }

  /* filter bar */
  .filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .filter-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  .filter-bar select { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--border)); border-radius: 4px; padding: 3px 6px; font-size: 12px; font-family: var(--vscode-font-family); }

  /* inline reply */
  .reply { margin: 8px 12px 10px; }
  .reply-input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; padding: 6px 8px; font-family: var(--vscode-font-family); font-size: 12px; resize: vertical; }
  .reply-actions { display: none; justify-content: flex-end; margin-top: 6px; }
  .reply.expanded .reply-actions { display: flex; }
</style>
</head>
<body>
  <div class="repo">${escapeHtml(this.repoFull)}</div>
  <h1>
    <span>[#${pr.number}] ${escapeHtml(pr.title)}</span>
    <button class="icon-btn" data-action="openExternal" data-url="${escapeHtml(pr.html_url)}" title="Open remote branch in browser">${ICONS.external}</button>
  </h1>
  <div class="meta-row">
    <span class="status" style="background:${STATUS_COLOR[status]}">${status}</span>
    <span class="branch">${escapeHtml(pr.head.ref)}</span> → <span class="branch">${escapeHtml(pr.base.ref)}</span>
    <span class="muted">by ${escapeHtml(pr.user.login)}</span>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="conversation">Conversation<span class="count">${detail.threads.reduce((n, t) => n + t.comments.length, 0)}</span></button>
    <button class="tab" data-tab="files">Files Changed<span class="count">${detail.files.length}</span></button>
    <span class="spacer"></span>
    <div class="tab-actions">
      <button class="btn-secondary btn-small" data-action="checkout" title="Check out ${escapeHtml(pr.head.ref)} locally">${ICONS.branch}<span>Checkout</span></button>
      <button class="btn-secondary btn-small" data-action="refresh" title="Refresh pull request data">${ICONS.sync}<span>Refresh</span></button>
    </div>
  </div>

  <div id="tab-conversation">
    <div class="layout">
      <div class="main">${conversationHtml}</div>
      ${this.sidebarHtml(pr, detail)}
    </div>
  </div>
  <div id="tab-files" style="display:none">${this.filesHtml(detail.files, detail.threads)}</div>

<script>
  const vscode = acquireVsCodeApi();

  document.querySelectorAll('.chip[data-color]').forEach((el) => {
    const hex = el.dataset.color;
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    el.style.color = (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1f2328' : '#ffffff';
  });

  const state = vscode.getState() || {};
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.getElementById('tab-conversation').style.display = name === 'conversation' ? '' : 'none';
    document.getElementById('tab-files').style.display = name === 'files' ? '' : 'none';
    vscode.setState({ ...state, tab: name });
  }
  if (state.tab === 'files') activateTab('files');
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => activateTab(t.dataset.tab))
  );

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.toggle-btn');
    if (toggle) {
      toggle.closest('.collapsible').classList.toggle('collapsed');
      return;
    }
    // Inline reply: expand actions on focus/click; submit posts to GitHub.
    const replySubmit = e.target.closest('.reply-submit');
    if (replySubmit) {
      const wrap = replySubmit.closest('.reply');
      const input = wrap.querySelector('.reply-input');
      if (input.value.trim()) {
        replySubmit.disabled = true;
        vscode.postMessage({ command: 'replyThread', threadId: wrap.dataset.thread, text: input.value });
      }
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const { action, thread, url, path, line, login, sid, comment } = btn.dataset;
      if (action === 'addContext') {
        btn.classList.add('ctx-added');
        setTimeout(() => btn.classList.remove('ctx-added'), 600);
      }
      vscode.postMessage({
        command: action,
        threadId: thread,
        commentId: comment,
        url,
        path,
        line: line ? Number(line) : undefined,
        login,
        sid,
      });
      return;
    }
    const link = e.target.closest('a[href]');
    if (link) {
      e.preventDefault();
      vscode.postMessage({ command: 'openExternal', url: link.href });
    }
  });

  // Expand reply action row when the textarea gains focus.
  document.addEventListener('focusin', (e) => {
    const input = e.target.closest('.reply-input');
    if (input) input.closest('.reply').classList.add('expanded');
  });

  // ---- Multi-facet filters (author + status + type, combined with AND) ----
  const fAuthor = document.getElementById('fAuthor');
  const fStatus = document.getElementById('fStatus');
  const fType = document.getElementById('fType');
  if (fAuthor && fStatus && fType) {
    const applyFilters = () => {
      const a = fAuthor.value, s = fStatus.value, t = fType.value;
      let visible = 0;
      document.querySelectorAll('#tab-conversation .filter-item').forEach((item) => {
        const okAuthor = a === 'all' || item.dataset.fauthor === a;
        const okType = t === 'all' || item.dataset.ftype === t;
        const okStatus = s === 'all' || item.dataset.fstatus === s;
        const show = okAuthor && okType && okStatus;
        item.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      const empty = document.getElementById('filterEmpty');
      if (empty) empty.style.display = visible === 0 ? '' : 'none';
      vscode.setState({ ...(vscode.getState() || {}), filters: { a, s, t } });
    };
    [fAuthor, fStatus, fType].forEach((el) => el.addEventListener('change', applyFilters));
    document.getElementById('fClear').addEventListener('click', () => {
      fAuthor.value = 'all'; fStatus.value = 'all'; fType.value = 'all';
      applyFilters();
    });
    // Restore saved filters, but only values that still exist as options
    // (stale values would blank the <select> and hide everything).
    const has = (sel, v) => [...sel.options].some((o) => o.value === v);
    const saved = (vscode.getState() || {}).filters;
    if (saved) {
      fAuthor.value = has(fAuthor, saved.a) ? saved.a : 'all';
      fStatus.value = has(fStatus, saved.s) ? saved.s : 'all';
      fType.value = has(fType, saved.t) ? saved.t : 'all';
      applyFilters();
    }
  }

  const btnComment = document.getElementById('btnComment');
  if (btnComment) {
    btnComment.addEventListener('click', () => {
      const box = document.getElementById('newComment');
      if (box.value.trim()) {
        btnComment.disabled = true;
        vscode.postMessage({ command: 'addComment', text: box.value });
      }
    });
  }
</script>
</body>
</html>`;
	}
}

/** GitHub-style relative time: "2 weeks ago", "3 days ago", "just now". */
function timeAgo(iso: string): string {
	const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return "just now";
	const units: Array<[number, string]> = [
		[60 * 60 * 24 * 365, "year"],
		[60 * 60 * 24 * 30, "month"],
		[60 * 60 * 24 * 7, "week"],
		[60 * 60 * 24, "day"],
		[60 * 60, "hour"],
		[60, "minute"],
	];
	for (const [unit, name] of units) {
		const value = Math.floor(seconds / unit);
		if (value >= 1) return `${value} ${name}${value > 1 ? "s" : ""} ago`;
	}
	return "just now";
}

/** Keeps only the final n lines of a string. */
function lastLines(text: string, n: number): string {
	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** The last line of a review-comment diff hunk = the commented line's current content. */
function lastHunkLine(hunk?: string): string | undefined {
	if (!hunk) return undefined;
	const lines = hunk.split("\n").filter((l) => l.length > 0 && !l.startsWith("\\"));
	const last = lines[lines.length - 1];
	if (!last || last.startsWith("@@")) return undefined;
	return last.slice(1);
}

/** Runs a shell command in the workspace root, resolving with stdout. */
function execShell(command: string): Promise<string> {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) return Promise.reject(new Error("No workspace folder open."));
	return new Promise((resolve, reject) => {
		exec(command, {cwd}, (err, stdout, stderr) => {
			if (err) reject(new Error((stderr || stdout || err.message).trim()));
			else resolve(stdout);
		});
	});
}

/** How many commits the local HEAD is behind origin/<base>. Null when undeterminable. */
function computeBehindBase(baseRef: string): Promise<number | null> {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile("git", ["rev-list", "--count", `HEAD..origin/${baseRef}`], {cwd}, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const n = parseInt(stdout.trim(), 10);
			resolve(Number.isNaN(n) ? null : n);
		});
	});
}

/** Derive the new-side line number a review comment targets from its diff hunk. */
function hunkTargetLine(hunk?: string): number | null {
	if (!hunk) return null;
	let n: number | null = null;
	for (const line of hunk.split("\n")) {
		const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (m) {
			n = parseInt(m[1], 10) - 1;
			continue;
		}
		if (n == null || line.startsWith("\\")) continue;
		if (!line.startsWith("-")) n++;
	}
	return n;
}
