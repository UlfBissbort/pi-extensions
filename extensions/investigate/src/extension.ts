import { randomBytes, randomUUID } from 'node:crypto';
import { ModelRuntime, type ExtensionAPI, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { loadConfig, loadWorkerContext } from './config.mjs';
import { createSemaphore, limitsForEffort, normalizeRequest, zeroUsage } from './core.mjs';
import { requestSchema, runInvestigation } from './worker.ts';
import { snapshot as runSnapshot, type RunState } from './run.ts';
import { applyCommand, commandCompletion, parseAddressed, statusText, STOP_MESSAGE, HARD_STOP_MESSAGE, unreadStopped } from './addressed.ts';
import { handoffDetails, handoffResultText } from './handoff.ts';
import { createRunStore, type RunStore } from './store.ts';
import { liveChain, renderInvestigationCall, renderInvestigationResult, renderReport, type ReportDetails } from './render.ts';
import {
  agentName, config as agentConfig, currentRun, isUserStop, lastRequest, railOf, status, userMessages,
  type InvestigationAgent, type Uid,
} from './agent.ts';
import { addressToken, applyAddress, completeAddress, firstPart, NAMES, pickName, resolveName, type Candidate } from './names.ts';
import { setTui } from './scroll.ts';
import { AGENT_ENTRY, delta, loadAgents } from './persist.ts';

// Agents stay in memory after their run so a later step can resume them, and are
// saved in the session so a reload keeps them. Oldest agents are dropped from
// memory first once the cap is reached.
const MAX_AGENTS = 100;
// Custom message type of the result of a run the user started, sent to the parent.
export const REPORT = 'investigation-report';
const agentHandle = (agent: InvestigationAgent) => `ET.InvestigationAgent('${agent.__uid}')`;
// A handle: the full ET.InvestigationAgent('🍃-…') form or the bare UID.
const handleUid = (handle: string): Uid | undefined =>
  handle.trim().match(/^(?:ET\.InvestigationAgent\(['"])?(🍃-[0-9a-f]{20})(?:['"]\))?$/)?.[1] as Uid | undefined;

// The parent model sees this header first in every result that has an agent:
// `name = handle status`, then what the user sent it during this run.
const quote = (messages: string[]) => messages.map(m => `- ${JSON.stringify(m)}`).join('\n');
function withHeader(agent: InvestigationAgent | undefined, text: string, late: string[] = []) {
  if (!agent) return text;
  const name = agentName(agent);
  const lines = [`${name ? `${name} = ` : ''}${agentHandle(agent)} ${status(agent)}`];
  const run = currentRun(agent);
  const start = run[0];
  const read = userMessages(run).map(m => m.content);
  if (start?.__type === 'ET.InvestigationRequest' && start.from === 'user') {
    lines.push(`The user resumed this investigator directly, not through your call, with these messages; its answer responds to them:\n${quote([String(start.request.question ?? ''), ...read])}`);
  } else if (read.length) {
    lines.push(`The user sent this investigator messages during this call; its answer takes them into account:\n${quote(read)}`);
  }
  if (late.length) lines.push(`The user sent these messages while it was finishing; it continues with them now and reports back in a separate message:\n${quote(late)}`);
  return `${lines.join('\n\n')}\n\n${text}`;
}

type Failure = Error & { usage?: ReturnType<typeof zeroUsage>; turns?: number; agent?: InvestigationAgent };

export async function registerInvestigation(pi: ExtensionAPI, root: string, dependencies = {
  createRuntime: (signal: AbortSignal) => ModelRuntime.create({ signal }),
}) {
  const initial = await loadConfig(root);
  const slots = createSemaphore(initial.config.limits.maxConcurrentInvestigations);
  const active = new Set<{ controller: AbortController; done: Promise<void> }>();
  const agents = new Map<Uid, InvestigationAgent>();
  // How much of each agent's record the session already holds.
  const saved = new Map<Uid, number>();
  const keepAgent = (agent: InvestigationAgent) => {
    agents.delete(agent.__uid);
    agents.set(agent.__uid, agent);
    while (agents.size > MAX_AGENTS) agents.delete(agents.keys().next().value!);
    const added = delta(agent, saved.get(agent.__uid) ?? 0);
    if (!added) return;
    try {
      pi.appendEntry?.(AGENT_ENTRY, added);
      saved.set(agent.__uid, agent.context_.length);
    } catch { /* Without a session the agent still lives in memory. */ }
  };
  // One writer per agent: a continued agent is reserved from call start, queueing included.
  const busy = new Set<Uid>();
  // Names are never issued twice in a session, including after a reload (see session_start).
  const issued = new Set<string>();
  // Investigators that can receive user messages now, by name: from launch until their run ends.
  const running = new Map<string, RunStore>();
  const finished = new Map<string, RunState>();
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
  const byName = (name: string) => [...agents.values()].find(agent => agentName(agent) === name);
  let closed = false;
  // Adjacent agents get different rail colours, including agents running in parallel.
  // An agent keeps its colour across all its runs.
  let nextRailIndex = 0;
  let ui: ExtensionUIContext | undefined;
  const notify = (text: string, level: 'info' | 'warning') => { try { ui?.notify(text, level); } catch { /* UI is optional */ } };

  // Track a run for shutdown: every run, from tool calls or the user, is aborted and awaited.
  const track = (signal?: AbortSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason ?? new Error('Investigation cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let finish!: () => void;
    const call = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    active.add(call);
    return { controller, end: () => { signal?.removeEventListener('abort', cancel); active.delete(call); finish(); } };
  };

  // One run of an investigator, shared by parent tool calls and user-started runs:
  // budget, deadline, a concurrency slot, the model runtime, then the worker.
  async function investigate({ args, previous, name, railIndex, store, signal, started, cwd, from }: {
    args: Record<string, unknown>; previous?: InvestigationAgent; name?: string; railIndex: number;
    store: RunStore; signal: AbortSignal; started: number; cwd: string; from?: 'user';
  }, abort: (reason: Error) => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};
    try {
      const snapshot = await loadConfig(root);
      store.admissionSignal.throwIfAborted();
      signal.throwIfAborted();
      const request = normalizeRequest(args, snapshot.config);
      const remaining = limitsForEffort(snapshot.config, request.effort).timeoutSeconds * 1000 - (Date.now() - started);
      if (remaining <= 0) throw new Error('Investigation deadline exceeded');
      timer = setTimeout(() => abort(new Error('Investigation deadline exceeded')), remaining);
      slots.setLimit(snapshot.config.limits.maxConcurrentInvestigations);
      release = await slots.acquire(AbortSignal.any([signal, store.admissionSignal]));
      store.admissionSignal.throwIfAborted();
      store.dispatch({ type: 'phase', phase: 'starting', model: `${snapshot.config.provider}/${snapshot.config.model}` });
      store.admissionSignal.throwIfAborted();
      const modelRuntime = await dependencies.createRuntime(signal);
      store.admissionSignal.throwIfAborted();
      // Re-read after admission: queued workers receive the current starting
      // instructions and repo skill, not the versions present before waiting.
      const freshSnapshot = { ...snapshot, ...await loadWorkerContext(root, snapshot.config) };
      signal.throwIfAborted();
      store.admissionSignal.throwIfAborted();
      return await runInvestigation({ snapshot: freshSnapshot, request, cwd, signal, modelRuntime, store, agent: previous, name, railIndex, from });
    } catch (error) {
      if (isUserStop(store.state().stop?.reason) && !(error as Failure).agent) {
        // Admission stopped before the worker could create its run. An existing
        // investigator still records the stopped continuation for reload/status.
        let agent = previous;
        if (agent) {
          const stamp = () => ({ __uid: `🍃-${randomBytes(10).toString('hex')}` as Uid, timestamp: Date.now() });
          const snapshot = await loadConfig(root);
          const request = normalizeRequest(args, snapshot.config);
          agent = { ...agent, context_: [...agent.context_,
            { __type: 'ET.InvestigationRequest', ...stamp(), request, limits: limitsForEffort(snapshot.config, request.effort), ...(from ? { from } : {}) },
            { __type: 'ET.RunEnded', ...stamp(), reason: store.state().stop!.reason, message: store.state().stop!.message },
          ] };
        }
        throw Object.assign(new Error(store.state().stop!.message), { agent, turns: 0, usage: zeroUsage() });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  // Stop accepting user messages for this run and take those it did not read.
  // Synchronous, so no message can arrive in between.
  const takeLate = (name: string | undefined, store: RunStore) => {
    if (name && running.get(name) === store) {
      running.delete(name);
      finished.delete(name);
      finished.set(name, store.state());
      while (finished.size > MAX_AGENTS) finished.delete(finished.keys().next().value!);
    }
    return store.state().inbox ?? [];
  };

  // The user wrote to an idle investigator, or wrote while it was finishing. It
  // resumes in the background with its full context. Its chain is a widget above
  // the editor while it works; when it ends, one message carries the finished
  // chain into the transcript and the result to the parent. Reservation happens
  // synchronously, before any other caller can reach the agent.
  function resumeForUser(agent: InvestigationAgent, messages: string[]) {
    const uid = agent.__uid;
    const name = agentName(agent);
    const railIndex = railOf(agent) ?? nextRailIndex++;
    const requestId = randomUUID();
    const started = Date.now();
    const run = track();
    busy.add(uid);
    const key = `investigate-run-${requestId}`;
    let view: ReturnType<typeof liveChain> | undefined;
    try {
      ui?.setWidget(key, (tui, theme) => { view = liveChain(theme, () => tui.requestRender()); return view.component; }, { placement: 'aboveEditor' });
    } catch { /* No terminal UI: the run still works and reports. */ }
    const store = createRunStore(requestId, snapshot => view?.update(snapshot), railIndex, name);
    store.dispatch({ type: 'phase', phase: 'queued', note: 'Waiting for an investigation slot.' });
    if (name) running.set(name, store);
    // Further messages wait in the inbox and enter before the first model request.
    for (const content of messages.slice(1)) store.dispatch({ type: 'messaged', content });
    // The previous run's preferences carry over; the user's message is the request.
    const { question: _q, context: _c, scope: _s, ...preferences } = lastRequest(agent)?.request ?? {};
    const args = { ...preferences, question: messages[0] };
    void (async () => {
      let text: string, failed: boolean, finalAgent: InvestigationAgent | undefined, late: string[] = [];
      let usage = zeroUsage();
      try {
        const result = await investigate({ args, previous: agent, name, railIndex, store, signal: run.controller.signal, started, cwd: agentConfig(agent).cwd, from: 'user' },
          reason => run.controller.abort(reason));
        late = takeLate(name, store);
        finalAgent = result.agent;
        store.dispatch({ type: 'phase', phase: 'completed' });
        text = withHeader(result.agent, result.text + (isUserStop(store.state().stop?.reason) ? unreadStopped(late) : ''), isUserStop(store.state().stop?.reason) ? [] : late);
        failed = false;
        usage = result.usage;
      } catch (error) {
        const e = error as Failure;
        late = takeLate(name, store);
        finalAgent = e.agent ?? agent;
        store.dispatch({ type: 'phase', phase: run.controller.signal.aborted ? 'cancelled' : 'failed', note: e.message });
        const stopped = isUserStop(store.state().stop?.reason);
        text = withHeader(finalAgent, stopped ? handoffResultText(finalAgent, store.state().stop!.message) + unreadStopped(late) : `Investigation failed or incomplete: ${e.message}`, stopped ? [] : late);
        failed = true;
        usage = e.usage ?? usage;
      }
      keepAgent(finalAgent);
      busy.delete(uid);
      store.close();
      try { ui?.setWidget(key, undefined); } catch { /* UI is optional */ }
      run.end();
      if (closed) return;
      const details: ReportDetails & Record<string, unknown> = {
        requestId, snapshot: runSnapshot(store.state()), failed, elapsedMs: Date.now() - started, usage, handoff: handoffDetails(finalAgent),
        agent: agentHandle(finalAgent), agentStatus: status(finalAgent), ...(name ? { name } : {}),
      };
      // To the parent: starts a turn when it is idle, follows its current run when busy.
      pi.sendMessage({ customType: REPORT, content: text, display: true, details }, { triggerTurn: true, deliverAs: 'followUp' });
      if (late.length && !isUserStop(store.state().stop?.reason)) resumeForUser(finalAgent, late);
    })();
    return name;
  }

  // Who `@` can address now: running investigators first, then retained finished ones,
  // which resume when written to.
  const candidates = (): Candidate[] => {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const live = [...running].map(([name, store]) => {
      const state = store.state();
      return { name, description: `${state.phase === 'running' ? 'running' : state.phase} · ${plural(runSnapshot(state).turns, 'model request')} · reads your message at its next turn` };
    });
    const idle = [...agents.values()].reverse().flatMap(agent => {
      const name = agentName(agent);
      return name && !running.has(name) ? [{ name, description: `${status(agent)} · resumes with your message, then reports to the parent` }] : [];
    });
    return [...live, ...idle];
  };
  let completing = false;
  const addCompletion = (target: ExtensionUIContext) => {
    if (completing) return;
    completing = true;
    target.addAutocompleteProvider(current => ({
      triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), '@'])],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const commands = commandCompletion(lines, cursorLine, cursorCol, candidates().map(c => c.name));
        if (commands) return commands;
        const token = addressToken(lines, cursorLine, cursorCol);
        const items = token === undefined ? [] : completeAddress(token, candidates());
        if (!items.length) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        return { prefix: `@${token}`, items: items.map(c => ({ value: c.name, label: `@${c.name}`, description: c.description })) };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const commands = commandCompletion(lines, cursorLine, cursorCol, candidates().map(c => c.name));
        if (commands?.prefix === prefix && commands.items.some(c => c.value === item.value && c.label === item.label)) return applyCommand(lines, cursorCol, item.value, prefix);
        const ours = addressToken(lines, cursorLine, cursorCol) !== undefined && item.label === `@${item.value}` && candidates().some(c => c.name === item.value);
        return ours ? applyAddress(lines, cursorCol, item.value) : current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  };

  pi.on('before_agent_start', async event => {
    if (event.systemPromptOptions.selectedTools.includes('investigate')) {
      const snapshot = await loadConfig(root);
      event.systemPromptOptions.sections.investigation = snapshot.parentPrompt;
    } else delete event.systemPromptOptions.sections.investigation;
  });
  pi.on('session_start', async (_event, ctx) => {
    // Agents saved on the active branch come back, with their names and colours.
    for (const agent of loadAgents(ctx.sessionManager?.getBranch?.() ?? []).slice(-MAX_AGENTS)) {
      agents.set(agent.__uid, agent);
      saved.set(agent.__uid, agent.context_.length);
      const name = agentName(agent);
      if (name) issued.add(name);
      nextRailIndex = Math.max(nextRailIndex, (railOf(agent) ?? -1) + 1);
    }
    // Every name this session ever showed, on any branch, stays taken.
    for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
      const message = (entry as { type?: string; message?: { role?: string; toolName?: string; customType?: string; details?: { name?: unknown } } }).message;
      const name = message?.details?.name;
      const ours = message?.role === 'toolResult' ? message.toolName === 'investigate' : message?.role === 'custom' && message.customType === REPORT;
      if (entry.type === 'message' && ours && typeof name === 'string') issued.add(name);
    }
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    try { addCompletion(ctx.ui); } catch { /* Not every UI supports autocomplete composition. */ }
    // An empty widget below the editor is the public way to receive the TUI; it renders no lines.
    ctx.ui.setWidget('investigate-scroll', tui => { setTui(tui); return { render: () => [], invalidate() {} }; }, { placement: 'belowEditor' });
  });
  // `@name message` from the user goes to that investigator, not to the parent:
  // into its inbox while it runs, or resuming it when it has finished.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    if (ctx.hasUI) ui = ctx.ui;
    const address = parseAddressed(event.text);
    if (!address) return { action: 'continue' };
    if (address.kind === 'command') {
      const target = resolveName(address.token, new Set([...issued, ...running.keys()]));
      if (target.kind !== 'one') notify(target.kind === 'ambiguous' ? `@${address.token} matches ${target.names.join(', ')}; write more of the name.` : `Unknown investigator: @${address.token}.`, 'warning');
      else if (address.error) notify(address.error, 'warning');
      else {
        const store = running.get(target.name);
        const agent = byName(target.name);
        if (address.command === 'status') notify(statusText(target.name, store?.state() ?? finished.get(target.name), agent, !!store), 'info');
        else if (!store || (store.state().awaiting !== 'handoff' && store.state().agent && status(store.state().agent!) !== 'running')) notify('Not running.', 'info');
        else {
          const hard = address.command === 'stopp';
          store.dispatch({ type: 'interrupted', reason: hard ? 'user_hard_stopped' : 'user_stopped', message: hard ? HARD_STOP_MESSAGE : STOP_MESSAGE });
          notify(hard ? 'Stopping now.' : 'Stop requested.', 'info');
        }
      }
      return { action: 'handled' };
    }
    const target = resolveName(address.token, running.keys());
    if (target.kind === 'ambiguous') { notify(`@${address.token} matches ${target.names.join(', ')}; write more of the name.`, 'warning'); return { action: 'handled' }; }
    if (target.kind === 'one') {
      running.get(target.name)!.dispatch({ type: 'messaged', content: address.message });
      notify(`Sent to ${target.name}; it reads it before its next model request.`, 'info');
      return { action: 'handled' };
    }
    // Not running: a known investigator resumes; anything else is ordinary text for the parent.
    const known = resolveName(address.token, issued);
    if (known.kind === 'ambiguous') { notify(`@${address.token} matches ${known.names.join(', ')}; write more of the name.`, 'warning'); return { action: 'handled' }; }
    if (known.kind !== 'one') return { action: 'continue' };
    const agent = byName(known.name);
    if (!agent) {
      notify(`${known.name} is not available on this branch of the session (or was evicted), so it cannot resume. Ask the parent for a new investigation.`, 'warning');
      return { action: 'handled' };
    }
    if (busy.has(agent.__uid)) {
      notify(`${known.name} is about to run for the parent; write to it again once it has started.`, 'warning');
      return { action: 'handled' };
    }
    resumeForUser(agent, [address.message]);
    notify(`Resuming ${known.name} with your message; it reports back to the parent when done.`, 'info');
    return { action: 'handled' };
  });
  pi.on('session_shutdown', async () => {
    closed = true;
    for (const call of active) call.controller.abort(new Error('Investigation extension shut down'));
    await Promise.allSettled([...active].map(call => call.done));
  });
  pi.registerMessageRenderer?.(REPORT, (message, options, theme) => renderReport(message, options as { expanded: boolean; outputPad?: number }, theme));
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
      if (ctx?.hasUI && ctx.ui) ui = ctx.ui;
      const run = track(signal);
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
          ? `Unknown agent ${address}: not retained here (never started on this branch of the session, or evicted). Start a new investigation and pass what it needs in context`
          : `Invalid agent: ${address} is neither an investigator name nor a handle`;
        else if (busy.has(uid)) refusal = { uid, ...(agentName(agents.get(uid)!) ? { name: agentName(agents.get(uid)!) } : {}) };
        else { previous = agents.get(uid); busy.add(reserved = uid); }
      }
      const name = lookupError || refusal ? undefined : previous ? agentName(previous) : issueName();
      const railIndex = (previous && railOf(previous)) ?? nextRailIndex++;
      // One store per investigation. Partial updates are UI data for Pi's tool
      // display, never parent-model transcript messages.
      const store = createRunStore(requestId, snapshot => onUpdate?.({ content: [], details: { requestId, snapshot } }), railIndex, name);
      store.dispatch({ type: 'phase', phase: 'queued', note: 'Waiting for an investigation slot.' });
      // From launch on, the user can write to it with @name, even while it is queued.
      if (name) running.set(name, store);
      // Messages the user sent while it was finishing start a new run after this one.
      let resume: { agent: InvestigationAgent; late: string[] } | undefined;
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
        const result = await investigate({ args: rest, previous, name, railIndex, store, signal: run.controller.signal, started, cwd: ctx.cwd },
          reason => run.controller.abort(reason));
        const late = takeLate(name, store);
        keepAgent(result.agent);
        if (late.length && !isUserStop(store.state().stop?.reason)) resume = { agent: result.agent, late };
        store.dispatch({ type: 'phase', phase: 'completed' });
        return {
          content: [{ type: 'text' as const, text: withHeader(result.agent, result.text + (isUserStop(store.state().stop?.reason) ? unreadStopped(late) : ''), isUserStop(store.state().stop?.reason) ? [] : late) }],
          details: { requestId, snapshot: runSnapshot(store.state()), model: result.model, turns: result.turns, elapsedMs: Date.now() - started, excerpts: result.excerpts, incompleteEvidence: result.warnings.length > 0, agent: agentHandle(result.agent), ...(name ? { name } : {}), agentStatus: status(result.agent) },
          usage: result.usage,
        };
      } catch (error) {
        const late = takeLate(name, store);
        const e = error as Failure;
        if (e.agent) keepAgent(e.agent);
        // A continuation that failed before its run started leaves the agent unchanged and still usable.
        const agent = e.agent ?? previous;
        const stopped = isUserStop(store.state().stop?.reason);
        if (late.length && agent && !closed && !stopped) resume = { agent, late };
        else if (late.length) notify(`${name ?? 'The investigator'} stopped before it could read your message.`, 'warning');
        store.dispatch({ type: 'phase', phase: run.controller.signal.aborted ? 'cancelled' : 'failed', note: e.message });
        return {
          content: [{ type: 'text' as const, text: withHeader(agent, stopped ? handoffResultText(agent, store.state().stop!.message) + unreadStopped(late) : `Investigation failed or incomplete: ${e.message}`, resume ? late : []) }],
          details: { requestId, snapshot: runSnapshot(store.state()), handoff: handoffDetails(agent), turns: e.turns ?? 0, elapsedMs: Date.now() - started, ...(name ? { name } : {}), ...(agent ? { agent: agentHandle(agent), agentStatus: status(agent) } : {}) },
          usage: e.usage ?? zeroUsage(), isError: true,
        };
      } finally {
        takeLate(name, store);
        store.close();
        if (reserved) busy.delete(reserved);
        run.end();
        // After releasing this call's reservation, so the new run can take it.
        if (resume && !closed) {
          resumeForUser(resume.agent, resume.late);
          notify(`${name} finished while you were writing; it continues with your message and reports back when done.`, 'info');
        }
      }
    },
  });
}
