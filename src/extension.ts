import * as vscode from 'vscode';
import { exec } from 'child_process';
import { GitHubClient, PullRequest } from './github';
import { PrListViewProvider } from './prListView';
import { PrDetailPanel } from './detailPanel';
import { ConversationViewProvider } from './conversationView';
import { ClaudeCodeBridge } from './claudeCode';

async function getGitRepo(): Promise<any | undefined> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) return undefined;
  const git = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
  return git.repositories[0];
}

function execGit(args: string): Promise<string> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return Promise.reject(new Error('No workspace folder open.'));
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/**
 * Checks out the PR's head branch on demand, prompting when the working tree
 * is dirty (stash / discard / cancel).
 */
async function checkoutPrBranch(pr: PullRequest): Promise<boolean> {
  const repo = await getGitRepo();
  if (!repo) {
    vscode.window.showErrorMessage('No Git repository available.');
    return false;
  }
  const branch = pr.head.ref;
  if (repo.state.HEAD?.name === branch) {
    vscode.window.setStatusBarMessage(`Already on ${branch}`, 2500);
    return true;
  }

  const dirty =
    repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0;
  if (dirty) {
    const pick = await vscode.window.showWarningMessage(
      `You have uncommitted changes. How should switching to "${branch}" handle them?`,
      { modal: true },
      'Stash & Checkout',
      'Discard & Checkout'
    );
    if (pick === undefined) return false;
    try {
      if (pick === 'Stash & Checkout') {
        await execGit('stash push -u -m "github-pr-manager: auto-stash before checkout"');
      } else {
        await execGit('reset --hard');
        await execGit('clean -fd');
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not prepare working tree: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  try {
    await repo.checkout(branch);
  } catch {
    try {
      await repo.fetch();
      await repo.createBranch(branch, true, `origin/${branch}`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not check out "${branch}": ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }
  vscode.window.setStatusBarMessage(`Checked out ${branch}`, 3000);
  return true;
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new GitHubClient();

  const prList = new PrListViewProvider(client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PrListViewProvider.viewId, prList, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const conversation = new ConversationViewProvider(client, () => PrDetailPanel.refreshCurrent());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConversationViewProvider.viewId, conversation, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const claudeCode = new ClaudeCodeBridge(context.extensionUri);

  /** Route attached context to whichever chat the user prefers. */
  const addContext = (
    label: string,
    contentText: string,
    target?: { pr: PullRequest; thread: import('./github').Thread }
  ) => {
    const mode = vscode.workspace
      .getConfiguration('prManager')
      .get<string>('chatMode', 'builtin');
    if (mode === 'builtin') {
      conversation.addContext(label, contentText, target);
    } else if (mode === 'claude-code-terminal') {
      void claudeCode.addContext(label, contentText);
    } else {
      void claudeCode.addContextToChat(label, contentText);
    }
  };

  // Reflect git working-tree state on the matching PR row.
  const refreshGitState = () => void prList.refreshGitState();
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt) {
    (gitExt.isActive ? Promise.resolve(gitExt.exports) : gitExt.activate()).then((api) => {
      const git = api.getAPI(1);
      const hook = (repo: any) => repo.state.onDidChange(refreshGitState);
      git.repositories.forEach(hook);
      context.subscriptions.push(git.onDidOpenRepository(hook));
    });
  }

  const setTitle = async () => {
    try {
      const repo = await client.getRepo();
      prList.setTitle(repo.full);
    } catch {
      prList.setTitle('Pull Requests');
    }
  };
  void setTitle();

  context.subscriptions.push(
    vscode.commands.registerCommand('prManager.refresh', () => {
      void setTitle();
      prList.refresh();
    }),
    vscode.commands.registerCommand('prManager.filter', () => prList.pickFilter()),
    vscode.commands.registerCommand('prManager.sort', () => prList.pickSort()),
    vscode.commands.registerCommand('prManager.openClaudeCode', () => claudeCode.open()),
    vscode.commands.registerCommand('prManager.discoverClaudeCommands', () =>
      claudeCode.discoverCommands()
    ),
    vscode.commands.registerCommand('prManager.openPr', async (pr: PullRequest) => {
      // Selecting a PR no longer checks out the branch — use the center-panel button.
      try {
        await PrDetailPanel.show(context.extensionUri, client, pr, {
          onOpenThread: (p, thread) => conversation.showThread(p, thread),
          onAddContext: addContext,
          onCheckout: async (p) => {
            const ok = await checkoutPrBranch(p);
            if (ok) {
              prList.refreshGitState();
              PrDetailPanel.refreshCurrent();
            }
          },
        });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to load PR #${pr.number}: ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );
}

export function deactivate(): void {}
