// main.ts — the entrypoint. One process: it binds a port, registers it with the
// suite, serves the forge until the suite reports done, then exits 0. With no
// MAKEFUN_ENV_URL it serves standalone on $PORT (local development and the kit's
// local runner), which never happens inside a trial.
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST {"port"} to the suite's /register, retrying with backoff; 200/409 accept. */
async function register(port: number): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/register`;
  let delayMs = 250;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        console.error(`register refused with HTTP ${response.status}; exiting`);
        process.exit(1);
      }
    } catch {
      // The suite is not up yet, or the request was cut: retry below.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

/** Poll the suite's /done until it answers {"done": true}. */
async function waitForDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
      if (body !== null && body.done === true) return;
    } catch {
      // A missed poll is not a failure: the suite may be mid-write.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const app = createApp({ token: TOKEN });
  if (ENV_URL !== '') {
    const port = await new Promise<number>((resolve, reject) => {
      app.once('error', reject);
      app.listen(0, () => {
        const address = app.address();
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('the server bound no port'));
      });
    });
    await register(port);
    await waitForDone();
    app.close();
    process.exit(0);
  }
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.error(`forge listening on port ${port}`);
  });
}

await main();
