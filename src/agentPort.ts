// A UI in an extension page (a window of the extension's own, which no site can reach)
// working with agents in a tab's content script, over one port (chrome.tabs.connect
// from the extension page, heard by the content script). An agent is plain data and
// functions. The tab sends each agent's data as it changes, only the fields that did
// (a field changed when it is another value or object than the one sent last); the
// page calls its functions by name, and only those. A content script only hears its
// own extension, and only a port of its name from it is answered.
// No framework: React hooks over it are in './react' (browser-guard/react).

/** The port's name unless one is given: one name per kind of extension page that connects. */
export const PANEL_PORT = 'panel';

/** A page agent: an object of data and functions (a scanner's findings and its `scan()`, say). */
export type Agent = object;
export type Agents = Record<string, Agent>;

type Message =
  // `view`: the fields changed since the last view of this agent (all of them the first time).
  | { type: 'view'; agent: string; view: Record<string, unknown>; commands: string[] }
  | { type: 'call'; agent: string; command: string; args: unknown[] };

/** What a port needs here: chrome.runtime.Port, or a test's stand-in. */
export interface PortLike {
  postMessage: (message: Message) => void;
  onMessage: { addListener: (listener: (message: Message) => void) => void };
}

/** An agent's data, and the names of what it does. */
function describe(agent: Agent): { view: Record<string, unknown>; commands: string[] } {
  const view: Record<string, unknown> = {};
  const commands: string[] = [];
  for (const [key, value] of Object.entries(agent as Record<string, unknown>)) {
    if (typeof value === 'function') commands.push(key);
    else view[key] = value;
  }
  return { view, commands };
}

/**
 * Tab side: tells the window about every agent now, and runs what it calls (only
 * the agents' own functions, by name). Returns how to tell it about one again.
 */
export function serveAgents(port: PortLike, getAgents: () => Agents): (name: string) => void {
  const sent = new Map<string, Record<string, unknown>>();
  const send = (name: string) => {
    const agent = getAgents()[name];
    if (!agent) return;
    const { view, commands } = describe(agent);
    const before = sent.get(name);
    const changed = before ? Object.fromEntries(Object.entries(view).filter(([key, value]) => before[key] !== value)) : view;
    sent.set(name, view);
    if (!before || Object.keys(changed).length) port.postMessage({ type: 'view', agent: name, view: changed, commands });
  };
  port.onMessage.addListener(message => {
    if (message?.type !== 'call' || !Array.isArray(message.args)) return;
    const agent = getAgents()[message.agent] as Record<string, unknown> | undefined;
    const command = agent && Object.prototype.hasOwnProperty.call(agent, message.command) ? agent[message.command] : undefined;
    if (typeof command === 'function') command(...message.args);
  });
  Object.keys(getAgents()).forEach(send);
  return send;
}

/** Window side: the agents as the tab describes them, their functions calling over the port (the same function each time). */
export function remoteAgents(port: PortLike, onChange: (agents: Agents) => void): void {
  const agents: Agents = {};
  const callers = new Map<string, (...args: unknown[]) => void>();
  const caller = (agent: string, command: string) => {
    const key = `${agent}.${command}`;
    // A function given straight to a button's onClick gets the click event: not data, and left out.
    const isEvent = (arg: unknown) => typeof arg === 'object' && arg !== null && 'nativeEvent' in arg;
    if (!callers.has(key)) callers.set(key, (...args) => port.postMessage({ type: 'call', agent, command, args: args.map(arg => isEvent(arg) ? null : arg) }));
    return callers.get(key)!;
  };
  port.onMessage.addListener(message => {
    if (message?.type !== 'view') return;
    agents[message.agent] = { ...agents[message.agent], ...message.view, ...Object.fromEntries(message.commands.map(command => [command, caller(message.agent, command)])) };
    onChange({ ...agents });
  });
}

/** What serveAgentsToWindows gives: tell the windows an agent changed, or stop serving. */
export interface AgentServer {
  changed: (agent: string) => void;
  stop: () => void;
}

/**
 * Tab side, in the content script: serves the agents to every extension page that
 * connects with a port named `name`, and sends one again when told it `changed`.
 */
export function serveAgentsToWindows(getAgents: () => Agents, name = PANEL_PORT): AgentServer {
  const senders = new Set<(agent: string) => void>();
  const onConnect = (port: chrome.runtime.Port) => {
    // Only the extension's own pages can connect to a content script; checked all the same.
    if (port.name !== name || port.sender?.id !== chrome.runtime.id) return;
    const send = serveAgents(port as unknown as PortLike, getAgents);
    senders.add(send);
    port.onDisconnect.addListener(() => senders.delete(send));
  };
  chrome.runtime.onConnect.addListener(onConnect);
  return {
    changed: agent => senders.forEach(send => send(agent)),
    stop: () => chrome.runtime.onConnect.removeListener(onConnect),
  };
}

export interface TabConnectionOptions {
  /** The port's name: the one the tab serves (serveAgentsToWindows). */
  name?: string;
  /** While the tab's content script isn't there yet (the page loading, the site just turned on), try again this often… */
  retryMs?: number;
  /** …this many times in a row. */
  retries?: number;
}

/**
 * Window side: the agents of a tab's content script, over a port to it. `onAgents` gets
 * them as they change, and null while there are none (not answered yet, or the port
 * closed: then it tries again a while). Returns how to disconnect.
 */
export function connectToTab(tabId: number, onAgents: (agents: Agents | null) => void,
  { name = PANEL_PORT, retryMs = 1000, retries = 30 }: TabConnectionOptions = {}): () => void {
  let port: chrome.runtime.Port | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  let gone = false;
  const connect = () => {
    port = chrome.tabs.connect(tabId, { name });
    remoteAgents(port as unknown as PortLike, agents => { tries = 0; onAgents(agents); });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      onAgents(null);
      if (!gone && ++tries <= retries) timer = setTimeout(connect, retryMs);
    });
  };
  connect();
  return () => {
    gone = true;
    clearTimeout(timer);
    port?.disconnect();
  };
}
