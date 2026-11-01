import { randomUUID } from 'node:crypto';
import { ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig, loadWorkerContext } from './config.mjs';
import { createSemaphore, limitsForEffort, normalizeRequest, zeroUsage } from './core.mjs';
import { requestSchema, runInvestigation } from './worker.ts';
import { snapshot as runSnapshot } from './run.ts';
import { createRunStore } from './store.ts';
import { renderInvestigationCall, renderInvestigationResult } from './render.ts';
import { status, type InvestigationAgent, type Uid } from './agent.ts';
import { setTui } from './scroll.ts';

// Agents stay in memory after their run so a later step can resume them. Oldest
// agents are dropped first once the cap is reached.
const MAX_AGENTS = 100;
const agentHandle = (agent: InvestigationAgent) => `ET.InvestigationAgent('${agent.__uid}')`;
// Accepts the full handle or the bare UID.
const handleUid = (handle: string): Uid | undefined =>
  handle.trim().match(/^(?:ET\.InvestigationAgent\(['"])?(🍃-[0-9a-f]{20})(?:['"]\))?$/)?.[1] as Uid | undefined;
// The parent model sees this line first in every result that has an agent.
const withHandle = (agent: InvestigationAgent | undefined, text: string) =>
  agent ? `${agentHandle(agent)} ${status(agent)}\n\n${text}` : text;

export async function registerInvestigation(pi: ExtensionAPI, root: string, dependencies = {
  createRuntime: (signal: AbortSignal) => ModelRuntime.create({ signal }),
}) {
  const initial = await loadConfig(root);
  const slots = createSemaphore(initial.config.limits.maxConcurrentInvestigations);
  const active = new Set<{ controller: AbortController; done: Promise<void> }>();
  const agents = new Map<Uid, InvestigationAgent>();
  const keepAgent = (agent: InvestigationAgent) => {
    agents.delete(agent.__uid);
    agents.set(agent.__uid, agent);
    while (agents.size > MAX_AGENTS) agents.delete(agents.keys().next().value!);
  };
  // One writer per agent: a continued agent is reserved from call start, queueing included.
  const busy = new Set<Uid>();
  let closed = false;
  // Adjacent calls get different rail colours, including calls running in parallel.
  let nextRailIndex = 0;

  pi.on('before_agent_start', async event => {
    if (event.systemPromptOptions.selectedTools.includes('investigate')) {
      const snapshot = await loadConfig(root);
      event.systemPromptOptions.sections.investigation = snapshot.parentPrompt;
    } else delete event.systemPromptOptions.sections.investigation;
  });
  // An empty widget below the editor is the public way to receive the TUI; it renders no lines.
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget('investigate-scroll', tui => { setTui(tui); return { render: () => [], invalidate() {} }; }, { placement: 'belowEditor' });
  });
  pi.on('session_shutdown', async () => {
    closed = true;
    for (const call of active) call.controller.abort(new Error('Investigation extension shut down'));
    await Promise.allSettled([...active].map(call => call.done));
  });
  pi.registerTool({
    name: 'investigate', label: 'Investigate',
    description: 'Default information-gathering tool: delegate lookups, code/library exploration, and note retrieval to an isolated smaller model. Supply a self-contained question; it cannot see this conversation. Returns final text and optional exact source excerpts, never the exploration trace, headed by the investigator handle and status. Pass that handle as agent to continue the same investigator with its full previous context. Issue independent calls together for parallel investigation.',
    promptSnippet: 'Gather information in isolated context; return a focused answer and selected exact source excerpts',
    promptGuidelines: ['Prefer investigate for information gathering, including ordinary lookups. Ask independent questions in parallel calls.'],
    parameters: requestSchema,
    executionMode: 'parallel',
    // The chain of step boxes is its own frame; Pi's default boxed shell would nest it.
    renderShell: 'self',
    renderCall: renderInvestigationCall,
    renderResult: renderInvestigationResult,
    // Unrestricted shell is available by default, so do not claim read-only safety.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, args, signal, onUpdate, ctx) {
      if (closed) throw new Error('Investigation extension is shutting down');
      const controller = new AbortController();
      const cancel = () => controller.abort(signal?.reason ?? new Error('Investigation cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const call = { controller, done };
      active.add(call);
      const started = Date.now();
      const requestId = randomUUID();
      // One store per investigation. Partial updates are UI data for Pi's tool
      // display, never parent-model transcript messages.
      const store = createRunStore(requestId, snapshot => onUpdate?.({ content: [], details: { requestId, snapshot } }), nextRailIndex++);
      store.dispatch({ type: 'phase', phase: 'queued', note: 'Waiting for an investigation slot.' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let release = () => {};
      let previous: InvestigationAgent | undefined;
      let reserved: Uid | undefined;
      try {
        const { agent: handle, ...rest } = args;
        if (handle !== undefined) {
          const uid = handleUid(handle);
          if (!uid) throw new Error(`Invalid agent handle: ${handle}`);
          if (busy.has(uid)) {
            // Not a failure of the investigator: this call never started, and its record is untouched.
            const text = `Not started: this investigator is still working on an earlier call. Wait for that result, then continue it, or start a new investigator.`;
            store.dispatch({ type: 'phase', phase: 'failed', note: text });
            return {
              content: [{ type: 'text' as const, text: `ET.InvestigationAgent('${uid}') running\n\n${text}` }],
              details: { requestId, snapshot: runSnapshot(store.state()), turns: 0, elapsedMs: Date.now() - started, agent: `ET.InvestigationAgent('${uid}')`, agentStatus: 'running' },
              usage: zeroUsage(), isError: true,
            };
          }
          previous = agents.get(uid);
          if (!previous) throw new Error(`Unknown agent ${handle}: not retained here (never started in this session, evicted, or lost on reload). Start a new investigation and pass what it needs in context`);
          busy.add(reserved = uid);
        }
        const snapshot = await loadConfig(root);
        controller.signal.throwIfAborted();
        const request = normalizeRequest(rest, snapshot.config);
        const remaining = limitsForEffort(snapshot.config, request.effort).timeoutSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) throw new Error('Investigation deadline exceeded');
        timer = setTimeout(() => controller.abort(new Error('Investigation deadline exceeded')), remaining);
        slots.setLimit(snapshot.config.limits.maxConcurrentInvestigations);
        release = await slots.acquire(controller.signal);
        store.dispatch({ type: 'phase', phase: 'starting', model: `${snapshot.config.provider}/${snapshot.config.model}` });
        const modelRuntime = await dependencies.createRuntime(controller.signal);
        // Re-read after admission: queued workers receive the current starting
        // instructions and repo skill, not the versions present before waiting.
        const freshSnapshot = { ...snapshot, ...await loadWorkerContext(root, snapshot.config) };
        controller.signal.throwIfAborted();
        const result = await runInvestigation({ snapshot: freshSnapshot, request, cwd: ctx.cwd, signal: controller.signal, modelRuntime, store, agent: previous });
        keepAgent(result.agent);
        store.dispatch({ type: 'phase', phase: 'completed' });
        return {
          content: [{ type: 'text' as const, text: withHandle(result.agent, result.text) }],
          details: { requestId, snapshot: runSnapshot(store.state()), model: result.model, turns: result.turns, elapsedMs: Date.now() - started, excerpts: result.excerpts, incompleteEvidence: result.warnings.length > 0, agent: agentHandle(result.agent), agentStatus: status(result.agent) },
          usage: result.usage,
        };
      } catch (error) {
        const e = error as Error & { usage?: ReturnType<typeof zeroUsage>; turns?: number; agent?: InvestigationAgent };
        if (e.agent) keepAgent(e.agent);
        // A continuation that failed before its run started leaves the agent unchanged and still usable.
        const agent = e.agent ?? previous;
        store.dispatch({ type: 'phase', phase: controller.signal.aborted ? 'cancelled' : 'failed', note: e.message });
        return {
          content: [{ type: 'text' as const, text: withHandle(agent, `Investigation failed or incomplete: ${e.message}`) }],
          details: { requestId, snapshot: runSnapshot(store.state()), turns: e.turns ?? 0, elapsedMs: Date.now() - started, ...(agent ? { agent: agentHandle(agent), agentStatus: status(agent) } : {}) },
          usage: e.usage ?? zeroUsage(), isError: true,
        };
      } finally {
        store.close();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (reserved) busy.delete(reserved);
        release(); active.delete(call); finish();
      }
    },
  });
}
