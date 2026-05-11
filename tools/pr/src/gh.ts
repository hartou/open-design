/**
 * Thin gh CLI wrappers. Combining many fields in a single `gh pr list --json`
 * call hits GitHub GraphQL with HTTP 502 across this repo's open queue, so
 * fetchOpenPrs splits the query into three chunks and joins them by number.
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type {
  GhAssignmentEvent,
  GhAssignmentTimeline,
  GhCommentsLite,
  GhCommitsLite,
  GhFiles,
  GhMeta,
  GhReviewsLite,
  GhStats,
  GhView,
} from "./types.js";

const execFile = promisify(execFileCallback);

async function ghOnce<T>(args: string[]): Promise<T> {
  const { stdout } = await execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

// Treat upstream-side flakes as transient: 502/503/504 from the GraphQL gateway,
// localized GraphQL "Something went wrong" responses (which gh surfaces as 502),
// and connection-level errors. Everything else (auth failure, 4xx, json parse
// errors, schema rejection) must surface to the caller — retry would just hide
// real problems.
function looksTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = (err as { stderr?: string }).stderr ?? "";
  const haystack = `${stderr} ${err.message}`;
  return /HTTP 5\d\d|GraphQL.*(?:502|503|504|timeout)|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN/i.test(
    haystack,
  );
}

// Minimum-touch debounce around gh CLI calls. Two retries (1s, 2s) cover the
// short-window GitHub gateway hiccups we've observed during PR-duty runs. Long
// outages still bubble up — this isn't an exponential-backoff resilience layer.
const RETRY_BACKOFF_MS: readonly number[] = [1000, 2000] as const;

export async function gh<T>(args: string[]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await ghOnce<T>(args);
    } catch (err) {
      lastError = err;
      if (!looksTransient(err) || attempt === RETRY_BACKOFF_MS.length) throw err;
      const delay = RETRY_BACKOFF_MS[attempt] ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export type RateLimitSnapshot = {
  remaining: number;
  limit: number;
  resetAt: string;
};

/**
 * Loads the login set of a GitHub org's members in one paginated REST call
 * (`gh api orgs/<org>/members --paginate`). Cached for the process lifetime.
 *
 * Used by the `org-member` classify tag to route operational nudges away
 * from GitHub comments (those go to internal IM instead). Outside repo
 * collaborators who are not org members are NOT included — they don't have
 * internal IM access either.
 */
let orgMembersCache: { org: string; members: Set<string> } | null = null;
export async function fetchOrgMembers(org: string): Promise<Set<string>> {
  if (orgMembersCache && orgMembersCache.org === org) return orgMembersCache.members;
  const { stdout } = await execFile(
    "gh",
    ["api", "--paginate", `orgs/${org}/members`, "--jq", ".[].login"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const members = new Set(stdout.split("\n").filter((line) => line.length > 0));
  orgMembersCache = { org, members };
  return members;
}

/**
 * Snapshot the current GraphQL rate-limit state. The query itself costs 1
 * point — cheap enough to call twice around an expensive fetch to compute
 * an exact delta cost.
 */
export async function fetchRateLimit(): Promise<RateLimitSnapshot> {
  const { stdout } = await execFile(
    "gh",
    ["api", "graphql", "-f", "query={ rateLimit { remaining limit resetAt } }"],
    { maxBuffer: 64 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { data: { rateLimit: RateLimitSnapshot } };
  return parsed.data.rateLimit;
}

/**
 * Resolves the current repo's `owner/name`. Cached for the process lifetime.
 * `gh pr list` auto-detects the repo from the cwd; for `gh api graphql` we
 * need to pass it explicitly.
 */
let repoSlugCache: { owner: string; name: string } | null = null;
export async function detectRepoSlug(): Promise<{ owner: string; name: string }> {
  if (repoSlugCache) return repoSlugCache;
  const { stdout } = await execFile("gh", ["repo", "view", "--json", "owner,name"], {
    maxBuffer: 64 * 1024,
  });
  const parsed = JSON.parse(stdout) as { owner: { login: string }; name: string };
  repoSlugCache = { owner: parsed.owner.login, name: parsed.name };
  return repoSlugCache;
}

/**
 * Generic cursor-paginated `pullRequests(states: OPEN, ...)` fetch via
 * `gh api graphql`. Used for the heavy-payload chunks (reviews, comments)
 * where a single 100-PR query was both data-heavy (≈ 500 KB) and more
 * likely to hit transient gateway flakes. Pagination spreads the load and
 * lets per-page retries recover narrowly. Page size is 30 — the GitHub
 * default — and keeps each node-traversal cost well under any limit.
 *
 * `nodeFields` is the per-PR graphql selection (must start with `number`
 * so callers can join by PR number downstream). The query template wraps
 * it with the `pullRequests(...)` connection + `pageInfo` so callers don't
 * need to know about cursors.
 */
const PR_LIST_PAGE_SIZE = 30;

type PaginatedPrPage<N> = {
  data: {
    repository: {
      pullRequests: {
        nodes: N[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };
};

async function fetchPaginatedPrList<N>(nodeFields: string): Promise<N[]> {
  const { owner, name } = await detectRepoSlug();
  const query = `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${nodeFields} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
  const all: N[] = [];
  let cursor: string | null = null;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `first=${PR_LIST_PAGE_SIZE}`,
    ];
    if (cursor !== null) args.push("-F", `cursor=${cursor}`);
    args.push("-f", `query=${query}`);
    const page = await gh<PaginatedPrPage<N>>(args);
    all.push(...page.data.repository.pullRequests.nodes);
    const info = page.data.repository.pullRequests.pageInfo;
    if (!info.hasNextPage) break;
    cursor = info.endCursor;
  }
  return all;
}

/**
 * Fetches per-PR commit timestamps via `gh api graphql`. We cap at
 * `commits(last: 5)` to keep the node count well under GitHub's
 * 500,000 traversal limit; `gh pr list --json commits` blows the
 * budget even at limit=50 because it traverses the full commits +
 * authors connection.
 */
const GRAPHQL_COMMITS_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        commits(last: 5) {
          nodes {
            commit {
              committedDate
              author { user { login } }
            }
          }
        }
      }
    }
  }
}`;

async function fetchOpenPrReviews(): Promise<GhReviewsLite[]> {
  type Node = {
    number: number;
    reviews: {
      nodes: {
        author: { login: string } | null;
        body: string;
        state: string;
        submittedAt: string;
        commit: { oid: string } | null;
      }[];
    };
  };
  // last: 30 captures the latest review per reviewer for any realistically
  // iterated PR (the heaviest in this repo's queue is ~15 reviews across
  // 4 rounds). The reducer in bot.ts picks the latest per author from
  // whatever subset we fetched.
  const rows = await fetchPaginatedPrList<Node>(
    `number
     reviews(last: 30) {
       nodes {
         author { login }
         body
         state
         submittedAt
         commit { oid }
       }
     }`,
  );
  return rows.map((row) => ({ number: row.number, reviews: row.reviews.nodes }));
}

async function fetchOpenPrComments(): Promise<GhCommentsLite[]> {
  type Node = {
    number: number;
    comments: {
      nodes: {
        author: { login: string } | null;
        body: string;
        createdAt: string;
      }[];
    };
  };
  // last: 30 covers the awaiting-* signal detection (we only need the most
  // recent comments to decide whether human-reviewer signal predates author
  // signal). PRs with > 30 comments are rare in this repo's queue.
  const rows = await fetchPaginatedPrList<Node>(
    `number
     comments(last: 30) {
       nodes {
         author { login }
         body
         createdAt
       }
     }`,
  );
  return rows.map((row) => ({ number: row.number, comments: row.comments.nodes }));
}

/**
 * Per-PR assignment lifecycle (ASSIGNED + UNASSIGNED timeline events). Only
 * available through `gh api graphql` — `gh pr list --json` doesn't expose
 * timeline data. The shape narrows the GraphQL union (TimelineItem) to the
 * two relevant event types via inline fragments.
 *
 * Used by the `assignment` subcommand to derive: per-current-assignee, when
 * were they assigned (latest ASSIGNED_EVENT not followed by UNASSIGNED_EVENT)
 * and by whom. Other assignment-related signals (idle time, status) compose
 * this with existing commits/comments data inside `assignment.ts`.
 */
async function fetchOpenPrAssignmentTimelines(): Promise<GhAssignmentTimeline[]> {
  type Node = {
    number: number;
    timelineItems: {
      nodes: Array<
        | {
            __typename: "AssignedEvent";
            createdAt: string;
            actor: { login: string } | null;
            assignee:
              | { __typename: "User"; login: string }
              | { __typename: string }
              | null;
          }
        | {
            __typename: "UnassignedEvent";
            createdAt: string;
            actor: { login: string } | null;
            assignee:
              | { __typename: "User"; login: string }
              | { __typename: string }
              | null;
          }
      >;
    };
  };
  const rows = await fetchPaginatedPrList<Node>(
    `number
     timelineItems(itemTypes: [ASSIGNED_EVENT, UNASSIGNED_EVENT], last: 20) {
       nodes {
         __typename
         ... on AssignedEvent {
           createdAt
           actor { login }
           assignee {
             __typename
             ... on User { login }
           }
         }
         ... on UnassignedEvent {
           createdAt
           actor { login }
           assignee {
             __typename
             ... on User { login }
           }
         }
       }
     }`,
  );
  return rows.map((row) => ({
    number: row.number,
    events: row.timelineItems.nodes.map<GhAssignmentEvent>((event) => {
      const kind: GhAssignmentEvent["kind"] =
        event.__typename === "AssignedEvent" ? "ASSIGNED" : "UNASSIGNED";
      const assignee =
        event.assignee && "login" in event.assignee
          ? { login: event.assignee.login }
          : null;
      return {
        kind,
        createdAt: event.createdAt,
        actor: event.actor,
        assignee,
      };
    }),
  }));
}

export { fetchOpenPrAssignmentTimelines };

/**
 * Resolves the authenticated gh CLI user's login. Cached for the process
 * lifetime — used by `tools-pr assignment --user me` to expand the alias.
 */
let currentUserCache: string | null = null;
export async function fetchCurrentUser(): Promise<string> {
  if (currentUserCache !== null) return currentUserCache;
  const { stdout } = await execFile("gh", ["api", "user", "--jq", ".login"], {
    maxBuffer: 64 * 1024,
  });
  const login = stdout.trim();
  if (login.length === 0) throw new Error("gh api user returned no login");
  currentUserCache = login;
  return login;
}

async function fetchOpenPrCommits(limit: number): Promise<GhCommitsLite[]> {
  const { owner, name } = await detectRepoSlug();
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `first=${limit}`,
      "-f",
      `query=${GRAPHQL_COMMITS_QUERY}`,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  type Response = {
    data: {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            commits: {
              nodes: Array<{
                commit: {
                  committedDate: string;
                  author: { user: { login: string } | null } | null;
                };
              }>;
            };
          }>;
        };
      };
    };
  };
  const parsed = JSON.parse(stdout) as Response;
  return parsed.data.repository.pullRequests.nodes.map((node) => ({
    number: node.number,
    commits: node.commits.nodes.map((entry) => ({
      oid: "",
      committedDate: entry.commit.committedDate,
      authors: [{ login: entry.commit.author?.user?.login ?? null }],
    })),
  }));
}

export type FetchOpenPrsOptions = {
  includeCommits?: boolean;
  includeComments?: boolean;
};

export type FetchOpenPrsResult = {
  meta: GhMeta[];
  stats: GhStats[];
  files: GhFiles[];
  reviews: GhReviewsLite[];
  commits?: GhCommitsLite[];
  comments?: GhCommentsLite[];
};

export async function fetchOpenPrs(
  limit: number,
  options: FetchOpenPrsOptions = {},
): Promise<FetchOpenPrsResult> {
  const baseArgs = ["pr", "list", "--state", "open", "--limit", String(limit)];
  const metaPromise = gh<GhMeta[]>([
    ...baseArgs,
    "--json",
    "number,title,author,createdAt,updatedAt,isDraft,reviewDecision,labels,maintainerCanModify,assignees",
  ]);
  const statsPromise = gh<GhStats[]>([
    ...baseArgs,
    "--json",
    "number,additions,deletions,changedFiles,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus",
  ]);
  const filesPromise = gh<GhFiles[]>([...baseArgs, "--json", "number,files"]);
  const reviewsPromise = fetchOpenPrReviews();
  const commitsPromise = options.includeCommits
    ? fetchOpenPrCommits(limit)
    : Promise.resolve<GhCommitsLite[] | undefined>(undefined);
  const commentsPromise = options.includeComments
    ? fetchOpenPrComments()
    : Promise.resolve<GhCommentsLite[] | undefined>(undefined);

  const [meta, stats, files, reviews, commits, comments] = await Promise.all([
    metaPromise,
    statsPromise,
    filesPromise,
    reviewsPromise,
    commitsPromise,
    commentsPromise,
  ]);

  const result: FetchOpenPrsResult = { meta, stats, files, reviews };
  if (commits !== undefined) result.commits = commits;
  if (comments !== undefined) result.comments = comments;
  return result;
}

const VIEW_FIELDS = [
  "url",
  "title",
  "body",
  "isDraft",
  "reviewDecision",
  "mergeStateStatus",
  "state",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "additions",
  "deletions",
  "changedFiles",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "maintainerCanModify",
  "assignees",
  "files",
  "statusCheckRollup",
  "reviews",
  "comments",
  "commits",
].join(",");

export async function fetchView(num: number): Promise<GhView> {
  return gh<GhView>(["pr", "view", String(num), "--json", VIEW_FIELDS]);
}

export function labelByPrefix(labels: { name: string }[], prefix: string): string | null {
  const hit = labels.find((label) => label.name.startsWith(prefix));
  return hit ? hit.name.slice(prefix.length) : null;
}

export function daysSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}
