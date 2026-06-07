import * as vscode from 'vscode';
import { GitHubClient, PullRequest } from './github';
import { PrListViewProvider } from './prListView';
import { PrDetailPanel } from './detailPanel';
import { ConversationViewProvider } from './conversationView';

async function getGitRepo(): Promise<any | undefined> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) return undefined;
  const git = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
  return git.repositories[0];
}

/** Best-effort checkout of the PR's head branch when a PR is selected. */
async function checkoutPrBranch(pr: PullRequest): Promise<void> {
  const repo = await getGitRepo();
  if (!repo) return;
  const branch = pr.head.ref;
  if (repo.state.HEAD?.name === branch) return;
  if (repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0) {
    vscode.window.showWarningMessage(
      `Not switching to "${branch}": you have uncommitted changes.`
    );
    return;
  }
  try {
    await repo.checkout(branch);
  } catch {
    try {
      await repo.fetch();
      await repo.createBranch(branch, true, `origin/${branch}`);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Could not check out "${branch}": ${err instanceof Error ? err.message : err}`
      );
      return;
    }
  }
  vscode.window.setStatusBarMessage(`Checked out ${branch}`, 3000);
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new GitHubClient();

  const prList = new PrListViewProvider(client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PrListViewProvider.viewId, prList, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // After a reply/comment is posted from the right panel, refresh the center panel.
  const conversation = new ConversationViewProvider(client, () => PrDetailPanel.refreshCurrent());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConversationViewProvider.viewId, conversation, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Header: name of repository.
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
    vscode.commands.registerCommand('prManager.openPr', async (pr: PullRequest) => {
      // Selecting a PR resets the right panel until a conversation is chosen.
      conversation.clear();
      await checkoutPrBranch(pr);
      try {
        await PrDetailPanel.show(context.extensionUri, client, pr, {
          onOpenThread: (p, thread) => conversation.showThread(p, thread),
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
