/**
 * Stream the extension's console output to this terminal.
 *
 *   npm run dev          # in one terminal
 *   npm run logs         # in another
 *
 * Extension logs are split across places that are all annoying to watch at
 * once: the service worker has its own inspector, and each content script logs
 * into the console of whatever page it was injected into. This attaches to all
 * of them over the DevTools Protocol and prints everything in one stream, so
 * "did it even run" is answerable without opening a single inspector.
 *
 * Requires Chrome to be listening on a debugging port. `npm run dev` passes
 * --remote-debugging-port=9222 for exactly this.
 */

export {}; // Makes this a module, so top-level await is allowed.

const PORT = Number(process.env.CDP_PORT ?? 9222);
const SHOW_ALL = process.argv.includes('--all');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const attached = new Set<string>();

function label(target: Target): string {
  if (target.type === 'service_worker') return `${CYAN}worker${RESET}`;
  try {
    return `${GREEN}${new URL(target.url).hostname}${RESET}`;
  } catch {
    return target.type;
  }
}

/** CDP hands back either a literal value or a description of an object. */
function renderArg(arg: {
  type: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: { name: string; value?: string }[] };
}): string {
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  if (arg.preview?.properties) {
    const fields = arg.preview.properties
      .map((property) => `${property.name}: ${property.value ?? '?'}`)
      .join(', ');
    return `{ ${fields} }`;
  }
  return arg.description ?? arg.type;
}

function colourFor(level: string): string {
  if (level === 'error') return RED;
  if (level === 'warning' || level === 'warn') return YELLOW;
  return '';
}

function attach(target: Target): void {
  if (!target.webSocketDebuggerUrl || attached.has(target.id)) return;
  attached.add(target.id);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const name = label(target);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    console.log(`${DIM}── attached to ${target.type}: ${target.url.slice(0, 80)}${RESET}`);
  });

  socket.addEventListener('message', (event) => {
    let payload: {
      method?: string;
      params?: {
        type?: string;
        args?: Parameters<typeof renderArg>[0][];
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
    };
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (payload.method === 'Runtime.consoleAPICalled') {
      const text = (payload.params?.args ?? []).map(renderArg).join(' ');
      // Extension logs are prefixed; everything else is the page's own noise.
      if (!SHOW_ALL && !text.includes('[keeper]')) return;

      const colour = colourFor(payload.params?.type ?? 'log');
      const time = new Date().toTimeString().slice(0, 8);
      console.log(`${DIM}${time}${RESET} ${name} ${colour}${text}${RESET}`);
      return;
    }

    if (payload.method === 'Runtime.exceptionThrown') {
      const details = payload.params?.exceptionDetails;
      const text = details?.exception?.description ?? details?.text ?? 'unknown error';
      console.log(`${DIM}${new Date().toTimeString().slice(0, 8)}${RESET} ${name} ${RED}${text}${RESET}`);
    }
  });

  const forget = () => {
    attached.delete(target.id);
  };
  socket.addEventListener('close', forget);
  socket.addEventListener('error', forget);
}

async function poll(): Promise<void> {
  let targets: Target[];
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = (await response.json()) as Target[];
  } catch {
    return; // Chrome not up yet, or the port isn't open. Try again shortly.
  }

  for (const target of targets) {
    const isWorker =
      target.type === 'service_worker' && target.url.startsWith('chrome-extension://');

    /*
     * Not just `page`. Under site isolation a cross-origin iframe runs in its
     * own process and shows up as a separate target of type `iframe`, so a
     * content script inside an embedded player logs somewhere `page` never
     * covers. Missing those made an injected script look like one that had
     * never run - the opposite conclusion.
     */
    const isFrame =
      ['page', 'iframe', 'webview', 'other'].includes(target.type) &&
      /^https?:/.test(target.url);

    if (isWorker || isFrame) attach(target);
  }
}

console.log(`${DIM}Watching Chrome on port ${PORT}. Showing [keeper] logs${SHOW_ALL ? ' and everything else' : ''}.${RESET}`);
console.log(`${DIM}Service workers sleep when idle - a gap in output is normal.${RESET}\n`);

await poll();
// Workers restart and tabs open; re-scan so neither is missed.
setInterval(() => void poll(), 2000);
