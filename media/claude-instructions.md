# PR review context — instructions for Claude

The section below labelled "Attached context" contains GitHub pull-request
comments, code reviews, and instructions the user attached from the GitHub PR
Manager extension.

How to use it:

- Each numbered item is a review comment, change request, or note to address.
- Every detail you need is inline — file paths, line numbers, diff hunks,
  author, and resolution status. Do **not** fetch anything from GitHub or the
  network; treat the attached text as the source of truth.
- When asked to fix or implement something, make minimal, focused changes that
  match the existing code style and conventions of this repository.
- Reference the specific file and line from the context when explaining a change.
- Wait for the user's explicit instruction before modifying files.

If an item is marked `[resolved]` or `[outdated]`, treat it as background only
unless the user says otherwise.
