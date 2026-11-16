// app.ts — the HTTP server: routing, authentication, the protocol headers every
// reply carries, and the request-body plumbing. The four surfaces live in their
// own modules; this file only dispatches to them.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGitRequest } from './githttp.ts';
import { handleRestRequest } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

export interface AppOptions {
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN). Empty only in local dev. */
  token: string;
}

export interface RequestContext {
  store: Store;
  /** The expected bearer token ('' means fail open: local development only). */
  token: string;
  /** The next deterministic request id. */
  nextRequestId: () => string;
  /** The request's own origin, from its Host header (for pagination links). */
  originOf: (req: IncomingMessage) => string;
}

/** Read a request body whole. Caps at 128 MiB, far above anything the suite sends. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body exceeds 128 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Send a JSON body with the given status. */
export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

/** Send a JSON error body: {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function createApp(options: AppOptions): Server {
  const store = new Store();
  const token = options.token;
  let requestSeq = 0;
  const ctx: RequestContext = {
    store,
    token,
    nextRequestId: () => `forge-${(++requestSeq).toString(16).padStart(8, '0')}`,
    originOf: (req) => `http://${req.headers.host ?? '127.0.0.1'}`,
  };

  const server = createServer((req, res) => {
    void dispatch(ctx, req, res).catch((error: unknown) => {
      // A handler must never take the server down: answer 500 JSON and keep serving.
      console.error(`handler error: ${error instanceof Error ? error.message : String(error)}`);
      try {
        if (!res.headersSent) sendError(res, 500, 'internal error');
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  return server;
}

async function dispatch(ctx: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;
  res.setHeader('x-github-request-id', ctx.nextRequestId());

  // The health probe is the one route that needs no token.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else requires the suite's bearer token (exact match).
  if (ctx.token !== '') {
    const presented = req.headers.authorization ?? '';
    if (presented !== `Bearer ${ctx.token}`) {
      sendError(res, 401, 'unauthorized');
      return;
    }
  }

  const body = await readBody(req);

  if (path === '/mcp') {
    await handleMcpRequest(ctx, req, res, body);
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphQLRequest(ctx, req, res, body);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRestRequest(ctx, req, res, url, body);
    return;
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    await handleGitRequest(ctx, req, res, url, body, gitMatch[1]!, gitMatch[2]!, gitMatch[3] ?? '');
    return;
  }
  sendError(res, 404, 'not found');
}
