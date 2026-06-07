# GitHub PR Manager

VS Code extension for managing GitHub pull requests in the currently open repository, with Claude Code–powered fix generation and conversation chat.

## Layout

**Activity bar icon → left panel (Pull Requests)**
- Header shows the `owner/repo` of the open repository.
- Lists every PR as `[#123] Title`; expand an item to see its labels, author/assignee, and status underneath.
- Toolbar buttons: **Filter** (status, label, author, assignee, text), **Sort** (newest, oldest, recently updated, title), **Refresh**.

**Center panel (PR detail)**
- Click a PR to open its detail view: full description, then all comments and review conversations grouped into containers (one per review thread, plus a general discussion container).
- Each container has an **Open in right panel →** button.

**Right panel (Conversation & Claude)**
- Shows the selected conversation with its diff context.
- **⚡ Generate fix** — asks Claude Code to investigate the repo and propose a fix for the comment.
- **💬 Reply** — write and post a reply directly to GitHub.
- Chat box at the bottom for free-form conversation with Claude about the thread; Claude's activity (file reads, searches) streams live.
- When Claude proposes code changes, an **✓ Apply suggested changes** button applies them to your working tree.

> Tip: for a true three-panel layout, drag the "Conversation & Claude" view into the **secondary sidebar** (right side). VS Code remembers the placement.

## Requirements

- A workspace folder that is a Git repo with a GitHub remote (`origin` preferred).
- GitHub authentication via VS Code's built-in GitHub sign-in (prompted on first use; `repo` scope).
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated (`claude` on your PATH, or set `prManager.claudeCliPath`).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `prManager.claudeCliPath` | `claude` | Path to the Claude Code CLI executable |
| `prManager.claudeModel` | _(empty)_ | Optional `--model` override for the CLI |

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press **F5** to launch the Extension Development Host. Package with `npm run package` (requires `@vscode/vsce`).

## Notes

- Claude runs non-interactively (`claude -p`) with the repo as cwd; it can read your code but file edits only happen through the explicit **Apply** button.
- Suggested changes use exact search/replace blocks; if a file changed since the suggestion was generated, the apply step reports which hunks couldn't be matched instead of guessing.
