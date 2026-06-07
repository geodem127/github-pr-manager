import * as vscode from 'vscode';

const API = 'https://api.github.com';

export interface Label {
  name: string;
  color: string;
}

export interface User {
  login: string;
  avatar_url?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  user: User;
  assignees: User[];
  requested_reviewers?: User[];
  labels: Label[];
  created_at: string;
  updated_at: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

export type PrStatus = 'open' | 'draft' | 'merged' | 'closed';

export function prStatus(pr: PullRequest): PrStatus {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  html_url: string;
  /** Review-comment specific */
  path?: string;
  line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
  /** Discussion-only: review verdict attached to a review summary comment */
  reviewState?: string;
}

export interface Thread {
  /** GraphQL node id for review threads (used for resolving); synthetic for discussion */
  id: string;
  kind: 'review' | 'discussion';
  title: string;
  /** Root review comment database id, used for replies (review threads only) */
  rootCommentId?: number;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  comments: Comment[];
}

export type ReviewerState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING';

export interface ReviewerInfo {
  login: string;
  avatar_url?: string;
  state: ReviewerState;
}

export interface LinkedIssue {
  number: number;
  title: string;
  url: string;
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrDetail {
  threads: Thread[];
  reviewers: ReviewerInfo[];
  linkedIssues: LinkedIssue[];
  /** SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null when no checks */
  checksState: string | null;
  /** clean | behind | dirty | blocked | unstable | unknown */
  mergeableState: string;
  changesRequested: boolean;
  files: ChangedFile[];
}

export interface RepoRef {
  owner: string;
  name: string;
  full: string;
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes {
              databaseId
              body
              createdAt
              url
              diffHunk
              author { login avatarUrl }
            }
          }
        }
      }
      closingIssuesReferences(first: 10) {
        nodes { number title url }
      }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { state } } }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}`;

export class GitHubClient {
  private repo?: RepoRef;
  private token?: string;

  async getRepo(): Promise<RepoRef> {
    if (this.repo) return this.repo;
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) throw new Error('Built-in Git extension not available.');
    const git = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
    if (git.repositories.length === 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        git.onDidOpenRepository(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const repository = git.repositories[0];
    if (!repository) throw new Error('No Git repository open in this workspace.');
    const remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }> =
      repository.state.remotes;
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = remote?.fetchUrl ?? remote?.pushUrl;
    if (!url) throw new Error('No Git remote found.');
    const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (!match) throw new Error(`Remote is not a GitHub repository: ${url}`);
    this.repo = { owner: match[1], name: match[2], full: `${match[1]}/${match[2]}` };
    return this.repo;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    this.token = session.accessToken;
    return this.token;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: string }
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) {
      this.token = undefined;
      throw new Error('GitHub authentication expired. Try refreshing.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors[0].message}`);
    if (!json.data) throw new Error('GitHub GraphQL: empty response');
    return json.data;
  }

  private async paginate<T>(path: string, maxPages = 3): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const repo = await this.getRepo();
    return this.paginate<PullRequest>(
      `/repos/${repo.full}/pulls?state=all&sort=created&direction=desc`
    );
  }

  async getPrDetail(prNumber: number): Promise<PrDetail> {
    const repo = await this.getRepo();
    const [restPr, issueComments, reviews, files, gql] = await Promise.all([
      this.request<PullRequest & { mergeable_state?: string }>(
        `/repos/${repo.full}/pulls/${prNumber}`
      ),
      this.paginate<Comment>(`/repos/${repo.full}/issues/${prNumber}/comments`),
      this.paginate<{
        id: number;
        body: string;
        user: User;
        state: string;
        submitted_at: string;
        html_url: string;
      }>(`/repos/${repo.full}/pulls/${prNumber}/reviews`),
      this.paginate<ChangedFile>(`/repos/${repo.full}/pulls/${prNumber}/files`),
      this.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                isOutdated: boolean;
                path: string | null;
                line: number | null;
                comments: {
                  nodes: Array<{
                    databaseId: number;
                    body: string;
                    createdAt: string;
                    url: string;
                    diffHunk: string;
                    author: { login: string; avatarUrl: string } | null;
                  }>;
                };
              }>;
            };
            closingIssuesReferences: {
              nodes: Array<{ number: number; title: string; url: string }>;
            };
            commits: {
              nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }>;
            };
          } | null;
        };
      }>(THREADS_QUERY, { owner: repo.owner, name: repo.name, number: prNumber }),
    ]);

    const prNode = gql.repository.pullRequest;

    // --- Review threads (GraphQL: gives resolve state + outdated) ---
    const threads: Thread[] = (prNode?.reviewThreads.nodes ?? []).map((n) => ({
      id: n.id,
      kind: 'review' as const,
      title: n.path ? `${n.path}${n.line != null ? `:${n.line}` : ''}` : 'Code review',
      rootCommentId: n.comments.nodes[0]?.databaseId,
      isResolved: n.isResolved,
      isOutdated: n.isOutdated,
      path: n.path ?? undefined,
      line: n.line,
      comments: n.comments.nodes.map((c) => ({
        id: c.databaseId,
        body: c.body,
        user: { login: c.author?.login ?? 'ghost', avatar_url: c.author?.avatarUrl },
        created_at: c.createdAt,
        html_url: c.url,
        path: n.path ?? undefined,
        line: n.line,
        diff_hunk: c.diffHunk,
      })),
    }));

    // --- General discussion: issue comments + review summaries, chronological ---
    const discussion: Comment[] = [
      ...issueComments,
      ...reviews
        .filter((r) => r.body && r.body.trim().length > 0)
        .map((r) => ({
          id: r.id,
          body: r.body,
          user: r.user,
          created_at: r.submitted_at,
          html_url: r.html_url,
          reviewState: r.state,
        })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (discussion.length > 0) {
      threads.push({
        id: `discussion-${prNumber}`,
        kind: 'discussion',
        title: 'General discussion',
        comments: discussion,
      });
    }

    // --- Reviewer states: latest substantive review per user, then pending requests ---
    const byLogin = new Map<string, ReviewerInfo>();
    const sortedReviews = [...reviews].sort((a, b) =>
      (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '')
    );
    for (const r of sortedReviews) {
      if (!r.user || r.user.login === restPr.user.login) continue;
      if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
        byLogin.set(r.user.login, {
          login: r.user.login,
          avatar_url: r.user.avatar_url,
          state: r.state,
        });
      } else if (r.state === 'COMMENTED' && !byLogin.has(r.user.login)) {
        byLogin.set(r.user.login, {
          login: r.user.login,
          avatar_url: r.user.avatar_url,
          state: 'COMMENTED',
        });
      }
    }
    for (const u of restPr.requested_reviewers ?? []) {
      byLogin.set(u.login, { login: u.login, avatar_url: u.avatar_url, state: 'PENDING' });
    }

    const reviewers = [...byLogin.values()];

    return {
      threads,
      reviewers,
      linkedIssues: prNode?.closingIssuesReferences.nodes ?? [],
      checksState: prNode?.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      mergeableState: restPr.mergeable_state ?? 'unknown',
      changesRequested: reviewers.some((r) => r.state === 'CHANGES_REQUESTED'),
      files,
    };
  }

  async resolveThread(threadNodeId: string): Promise<void> {
    await this.graphql(RESOLVE_MUTATION, { id: threadNodeId });
  }

  async reRequestReview(prNumber: number, login: string): Promise<void> {
    const repo = await this.getRepo();
    await this.request(`/repos/${repo.full}/pulls/${prNumber}/requested_reviewers`, {
      method: 'POST',
      body: JSON.stringify({ reviewers: [login] }),
    });
  }

  async addIssueComment(prNumber: number, body: string): Promise<Comment> {
    const repo = await this.getRepo();
    return this.request<Comment>(`/repos/${repo.full}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async reply(prNumber: number, thread: Thread, body: string): Promise<Comment> {
    const repo = await this.getRepo();
    if (thread.kind === 'review' && thread.rootCommentId) {
      return this.request<Comment>(
        `/repos/${repo.full}/pulls/${prNumber}/comments/${thread.rootCommentId}/replies`,
        { method: 'POST', body: JSON.stringify({ body }) }
      );
    }
    return this.request<Comment>(`/repos/${repo.full}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}
