// React hooks over the agent port (./agentPort): a content script's components serve
// their agents, an extension page's components use them. Import as browser-guard/react.

import { useEffect, useRef, useState } from 'react';
import { connectToTab, PANEL_PORT, serveAgentsToWindows } from './agentPort';
import type { AgentServer, Agents } from './agentPort';

/** Tab side, in the content script: serves `agents` to every window that connects (port `name`), sending each change. */
export function useAgentServer(agents: Agents, name = PANEL_PORT): void {
  const current = useRef(agents);
  current.current = agents;
  const server = useRef<AgentServer | null>(null);
  useEffect(() => {
    const served = serveAgentsToWindows(() => current.current, name);
    server.current = served;
    return () => served.stop();
  }, [name]);
  // After each render, the agents that changed are sent again.
  const sent = useRef<Agents>({});
  useEffect(() => {
    for (const [agent, value] of Object.entries(agents)) {
      if (sent.current[agent] !== value) server.current?.changed(agent);
    }
    sent.current = agents;
  });
}

/**
 * Window side: the agents of the tab's content script; null until it answers (or while
 * the tab has none of ours). Connects again when the tab loads a page (`generation` changes).
 */
export function useRemoteAgents(tabId: number | null, generation: number, name = PANEL_PORT): Agents | null {
  const [agents, setAgents] = useState<Agents | null>(null);
  useEffect(() => {
    setAgents(null);
    if (tabId === null) return;
    return connectToTab(tabId, setAgents, { name });
  }, [tabId, generation, name]);
  return agents;
}
