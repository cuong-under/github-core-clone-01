// mcp.ts — the Model Context Protocol surface: JSON-RPC 2.0 over Streamable HTTP
// (plain JSON replies; no SSE). The modern era is answered through
// `server/discover`, with `initialize` kept for legacy clients, and six tools
// that act on the same store the REST and GraphQL surfaces share.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, type RequestContext } from './app.ts';
import { createIssue, createPull, squashMerge } from './ops.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';
import { VIEWER_LOGIN, type RepoState } from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';

// The six canonical tools, defined once so tools/list answers byte-for-byte the
// same array on every call. Property names are the canonical ones the suite's
// argument mapper fills one-to-one; no `full_name` property anywhere.
const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes come from.' },
        base: { type: 'string', description: 'The branch the changes merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

class ToolFailure extends Error {}

function resultEnvelope(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorEnvelope(id: RpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`missing required argument "${name}"`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function requireRepo(ctx: RequestContext, owner: string, name: string): RepoState {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`repository "${owner}/${name}" was not found`);
  return repo;
}

function toolPayload(ctx: RequestContext, req: IncomingMessage, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (ctx.store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        throw new ToolFailure(`repository "${repoName}" already exists`);
      }
      // The owner argument is accepted and ignored: a repository always belongs
      // to the login the token names.
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        optionalString(args, 'description'),
      );
      return repoObject(ctx, req, repo);
    }
    case 'get_repo': {
      const repo = requireRepo(ctx, requireString(args, 'owner'), requireString(args, 'repo'));
      return repoObject(ctx, req, repo);
    }
    case 'create_issue': {
      const repo = requireRepo(ctx, requireString(args, 'owner'), requireString(args, 'repo'));
      const created = createIssue(ctx.store, repo, requireString(args, 'title'), optionalString(args, 'body'), []);
      if ('error' in created) throw new ToolFailure(created.error);
      return issueObject(ctx, req, repo, created.issue);
    }
    case 'list_issues': {
      const repo = requireRepo(ctx, requireString(args, 'owner'), requireString(args, 'repo'));
      const state = optionalString(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueObject(ctx, req, repo, issue));
    }
    case 'create_pull_request': {
      const repo = requireRepo(ctx, requireString(args, 'owner'), requireString(args, 'repo'));
      const created = createPull(
        ctx.store,
        repo,
        requireString(args, 'head'),
        requireString(args, 'base'),
        requireString(args, 'title'),
        optionalString(args, 'body'),
      );
      if ('error' in created) throw new ToolFailure(created.error);
      return pullObject(ctx, req, repo, created.pull);
    }
    case 'merge_pull_request': {
      const repo = requireRepo(ctx, requireString(args, 'owner'), requireString(args, 'repo'));
      const pullNumber = args.pull_number;
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
        throw new ToolFailure('missing required argument "pull_number"');
      }
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) throw new ToolFailure(`pull request #${pullNumber} was not found`);
      const outcome = squashMerge(repo, pull);
      if (!outcome.ok) {
        throw new ToolFailure(
          outcome.reason === 'conflict' ? 'the pull request has a merge conflict' : 'the pull request cannot be merged',
        );
      }
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', number: pull.number, state: pull.state };
    }
    default:
      throw new ToolFailure(`unknown tool "${name}"`);
  }
}

function handleRequest(ctx: RequestContext, req: IncomingMessage, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = (typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null) as RpcId;
  const method = message.method;
  if (typeof method !== 'string') {
    return errorEnvelope(id, { code: -32600, message: 'the request carries no method' });
  }
  // Notifications carry no id and get no reply; the transport answers 202.
  if (message.id === undefined) return null;

  const params = (message.params !== undefined && typeof message.params === 'object' && message.params !== null
    ? (message.params as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return resultEnvelope(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return resultEnvelope(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return resultEnvelope(id, {});
    case 'tools/list':
      return resultEnvelope(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        return errorEnvelope(id, { code: -32602, message: 'tools/call needs a tool name' });
      }
      const args =
        params.arguments !== undefined && typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const payload = toolPayload(ctx, req, toolName, args);
        const text = JSON.stringify(payload);
        return resultEnvelope(id, {
          content: [{ type: 'text', text }],
          structuredContent: payload,
        });
      } catch (error) {
        if (error instanceof ToolFailure) {
          return errorEnvelope(id, { code: -32602, message: error.message });
        }
        throw error;
      }
    }
    default:
      return errorEnvelope(id, { code: -32601, message: `method not found: ${method}` });
  }
}

export async function handleMcpRequest(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 404, 'not found');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // A body that is not JSON is a JSON-RPC parse error, answered 400.
    sendJson(res, 400, errorEnvelope(null, { code: -32700, message: 'Parse error' }));
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const replies: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      replies.push(errorEnvelope(null, { code: -32600, message: 'the request is not an object' }));
      continue;
    }
    const reply = handleRequest(ctx, req, message as Record<string, unknown>);
    if (reply !== null) replies.push(reply);
  }
  if (replies.length === 0) {
    // Only notifications arrived: accepted, nothing to say.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? replies : replies[0]);
}
