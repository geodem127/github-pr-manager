import * as vscode from 'vscode';
import { GitHubClient, PullRequest } from './github';
import { PrListViewProvider } from './prListView';
import { PrDetailPanel } from './detailPanel';
import { ConversationViewProvider } from './conversationView';

export function activate(context: vscode.ExtensionContext): void {
  const client = new GitHubClient();

  const prList = new PrListViewProvider(client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PrListViewProvider.viewId, prList, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const conversation = new ConversationViewProvider(client);
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
