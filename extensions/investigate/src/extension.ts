import { randomUUID } from 'node:crypto';
import { ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig, loadWorkerContext } from './config.mjs';
import { createSemaphore, limitsForEffort, normalizeRequest, zeroUsage } from './core.mjs';
import { requestSchema, runInvestigation } from './worker.ts';
import { snapshot as runSnapshot } from './run.ts';
import { createRunStore } from './store.ts';
import { renderInvestigationCall, renderInvestigationResult } from './render.ts';
import { agentName, currentRun, status, userMessages, type InvestigationAgent, type Uid } from './agent.ts';
import { firstPart, NAMES, parseAddress, pickName, resolveName } from './names.ts';
import type { RunStore } from './store.ts';
import { setTui } from './scroll.ts';

// Agents stay in memory after their run so a later step can resume them. Oldest
// agents are dropped first once the cap is reached.
const MAX_AGENTS = 100;
const agentHandle = (agent: InvestigationAgent) => `ET.InvestigationAgent('${agent.__uid}')`;
// A handle: the full ET.InvestigationAgent('🍃-…') form or the bare UID.
const handleUid = (handle: string): Uid | undefined =>
  handle.trim().match(/^(?:ET\.InvestigationAgent\(['"])?(🍃-[0-9a-f]{20})(?:['"]\))?$/)?.[1] as Uid | undefined;
// The parent model sees this header first in every result that has an agent:
// `name = handle status`, then any messages the user sent it during this call.
const quote = (messages: string[]) => messages.map(m => `- ${JSON.stringify(m)}`).join('\n');
function withHeader(agent: InvestigationAgent | undefined, text: string, late: string[] = []) {
  if (!agent) return text;
  const name = agentName(agent);
  const lines = [`${name ? `${name} = ` : ''}${agentHandle(agent)} ${status(agent)}`];
  const read = userMessages(currentRun(agent)).map(m => m.content);
  if (read.length) lines.push(`The user sent this investigator messages during this call; its answer takes them into account:\n${quote(read)}`);
  if (late.length) lines.push(`The user sent these messages after it had finished; it has not read them:\n${quote(late)}`);
  return `${lines.join('\n\n')}\n\n${text}`;
}

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
  // Names are never issued twice in a session, including after a reload (see session_start).
  const issued = new Set<string>();
  // Investigators that can receive user messages now, by name: from launch until their call ends.
  const running = new Map<string, RunStore>();
  const issueName = () => {
    const name = pickName(NAMES, issued, new Set([...running.keys()].map(firstPart)));
    issued.add(name);
    return name;
  };
  // The parent may address a retained agent by handle, bare UID, or exact name.
  const findAgent = (address: string): Uid | undefined => {
    const uid = handleUid(address);
    if (uid) return agents.has(uid) ? uid : undefined;
    for (const agent of agents.values()) if (agentName(agent) === address.trim()) return agent.__uid;
    return undefined;
  };
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
    // Every name this session ever showed, on any branch, stays taken.
    for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
      const message = (entry as { type?: string; message?: { role?: string; toolName?: string; details?: { name?: unknown } } }).message;
      if (entry.type === 'message' && message?.role === 'toolResult' && message.toolName === 'investigate' && typeof message.details?.name === 'string') issued.add(message.details.name);
    }
    if (!ctx.hasUI) return;
    ctx.ui.setWidget('investigate-scroll', tui => { setTui(tui); return { render: () => [], invalidate() {} }; }, { placement: 'belowEditor' });
  });
  // `@name message` from the user goes to that running investigator, not to the parent.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    const address = parseAddress(event.text);
    if (!address) return { action: 'continue' };
    const target = resolveName(address.token, running.keys());
    const say = (text: string, level: 'info' | 'warning') => { if (ctx.hasUI) ctx.ui.notify(text, level); };
    if (target.kind === 'ambiguous') { say(`@${address.token} matches ${target.names.join(', ')}; write more of the name.`, 'warning'); return { action: 'handled' }; }
    if (target.kind === 'none') {
      // A known investigator that is not running cannot read it; anything else is ordinary text for the parent.
      const idle = resolveName(address.token, issued);
      if (idle.kind !== 'one') return { action: 'continue' };
      say(`${idle.name} is not running, so it cannot read messages. Ask the parent to continue it.`, 'warning');
      return { action: 'handled' };
    }
    running.get(target.name)!.dispatch({ type: 'messaged', content: address.message });
    say(`Sent to ${target.name}; it reads it before its next model request.`, 'info');
    return { action: 'handled' };
  });
  pi.on('session_shutdown', async () => {
    closed = true;
    for (const call of active) call.controller.abort(new Error('Investigation extension shut down'));
    await Promise.allSettled([...active].map(call => call.done));
  });
  pi.registerTool({
    name: 'investigate', label: 'Investigate',
    description: 'Default information-gathering tool: delegate lookups, code/library exploration, and note retrieval to an isolated smaller model. Supply a self-contained question; it cannot see this conversation. Returns final text and optional exact source excerpts, never the exploration trace, headed by the investigator name, handle, and status. Pass that name or handle as agent to continue the same investigator with its full previous context. Issue independent calls together for parallel investigation.',
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
      // Which investigator runs: a continued one (looked up and reserved now, so
      // parallel calls cannot both write to it), or a new one with a fresh name.
      let previous: InvestigationAgent | undefined;
      let reserved: Uid | undefined;
      let refusal: { uid: Uid; name?: string } | undefined;
      let lookupError: string | undefined;
      const { agent: address, ...rest } = args;
      if (address !== undefined) {
        const uid = findAgent(address);
        if (!uid) lookupError = handleUid(address) || NAMES.includes(address.replace(/_\d+$/, '')) || issued.has(address)
          ? `Unknown agent ${address}: not retained here (never started in this session, evicted, or lost on reload). Start a new investigation and pass what it needs in context`
          : `Invalid agent: ${address} is neither an investigator name nor a handle`;
        else if (busy.has(uid)) refusal = { uid, ...(agents.get(uid) && agentName(agents.get(uid)!) ? { name: agentName(agents.get(uid)!) } : {}) };
        else { previous = agents.get(uid); busy.add(reserved = uid); }
      }
      const name = lookupError || refusal ? undefined : previous ? agentName(previous) : issueName();
      // One store per investigation. Partial updates are UI data for Pi's tool
      // display, never parent-model transcript messages.
      const store = createRunStore(requestId, snapshot => onUpdate?.({ content: [], details: { requestId, snapshot } }), nextRailIndex++, name);
      store.dispatch({ type: 'phase', phase: 'queued', note: 'Waiting for an investigation slot.' });
      // From launch on, the user can write to it with @name, even while it is queued.
      if (name) running.set(name, store);
      const stopListening = () => { if (name && running.get(name) === store) running.delete(name); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let release = () => {};
      try {
        if (refusal) {
          // Not a failure of the investigator: this call never started, and its record is untouched.
          const text = `Not started: this investigator is still working on an earlier call. Wait for that result, then continue it, or start a new investigator.`;
          store.dispatch({ type: 'phase', phase: 'failed', note: text });
          const handle = `ET.InvestigationAgent('${refusal.uid}')`;
          return {
            content: [{ type: 'text' as const, text: `${refusal.name ? `${refusal.name} = ` : ''}${handle} running\n\n${text}` }],
            details: { requestId, snapshot: runSnapshot(store.state()), turns: 0, elapsedMs: Date.now() - started, agent: handle, ...(refusal.name ? { name: refusal.name } : {}), agentStatus: 'running' },
            usage: zeroUsage(), isError: true,
          };
        }
        if (lookupError) throw new Error(lookupError);
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
        const result = await runInvestigation({ snapshot: freshSnapshot, request, cwd: ctx.cwd, signal: controller.signal, modelRuntime, store, agent: previous, name });
        // Synchronously from here: no message can arrive between reading the inbox and leaving the registry.
        stopListening();
        const late = store.state().inbox ?? [];
        keepAgent(result.agent);
        store.dispatch({ type: 'phase', phase: 'completed' });
        if (late.length && ctx.hasUI) ctx.ui.notify(`${name ?? 'The investigator'} finished before reading ${late.length === 1 ? 'your message' : `${late.length} of your messages`}; continue it to follow up.`, 'warning');
        return {
          content: [{ type: 'text' as const, text: withHeader(result.agent, result.text, late) }],
          details: { requestId, snapshot: runSnapshot(store.state()), model: result.model, turns: result.turns, elapsedMs: Date.now() - started, excerpts: result.excerpts, incompleteEvidence: result.warnings.length > 0, agent: agentHandle(result.agent), ...(name ? { name } : {}), agentStatus: status(result.agent) },
          usage: result.usage,
        };
      } catch (error) {
        stopListening();
        const late = store.state().inbox ?? [];
        const e = error as Error & { usage?: ReturnType<typeof zeroUsage>; turns?: number; agent?: InvestigationAgent };
        if (e.agent) keepAgent(e.agent);
        // A continuation that failed before its run started leaves the agent unchanged and still usable.
        const agent = e.agent ?? previous;
        store.dispatch({ type: 'phase', phase: controller.signal.aborted ? 'cancelled' : 'failed', note: e.message });
        return {
          content: [{ type: 'text' as const, text: withHeader(agent, `Investigation failed or incomplete: ${e.message}`, late) }],
          details: { requestId, snapshot: runSnapshot(store.state()), turns: e.turns ?? 0, elapsedMs: Date.now() - started, ...(name ? { name } : {}), ...(agent ? { agent: agentHandle(agent), agentStatus: status(agent) } : {}) },
          usage: e.usage ?? zeroUsage(), isError: true,
        };
      } finally {
        stopListening();
        store.close();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (reserved) busy.delete(reserved);
        release(); active.delete(call); finish();
      }
    },
  });
}
