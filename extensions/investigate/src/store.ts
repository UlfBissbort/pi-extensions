// Edge: holds one run's state, applies reduceRun, and executes publish commands.
// Effect commands (model, tools, records) are returned to the caller to perform.
// Streaming publishes are coalesced to at most one per 100 ms; that is a timing
// concern of the edge, not of the reducer.
import { isUserStop } from './agent.ts';
import { initRun, reduceRun, snapshot, type RunCommand, type RunEvent, type RunState, type Snapshot } from './run.ts';

export type RunStore = {
  dispatch(event: RunEvent): RunCommand[];
  state(): RunState;
  admissionSignal: AbortSignal;
  signalFor(stage: 'research' | 'handoff'): AbortSignal;
  close(): void;
};

export function createRunStore(requestId: string, publish: (snapshot: Snapshot) => void = () => {}, railIndex = 0, name?: string): RunStore {
  const admission = new AbortController();
  const stages = { research: new AbortController(), handoff: new AbortController() };
  let state = initRun(requestId, railIndex, name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    try { publish(snapshot(state)); } catch { /* UI failure must not abort a paid investigation. */ }
  };
  return {
    admissionSignal: admission.signal,
    signalFor: stage => stages[stage].signal,
    dispatch(event) {
      const [next, commands] = reduceRun(state, event);
      state = next;
      if (isUserStop(state.stop?.reason)) admission.abort(new Error(state.stop!.message));
      const effects: RunCommand[] = [];
      let publishNow = false, publishLater = false;
      for (const command of commands) {
        if (command.type === 'abort') stages[command.stage].abort(new Error('Hard-stopped by the user'));
        else if (command.type !== 'publish') effects.push(command);
        else if (command.throttle) publishLater = true;
        else publishNow = true;
      }
      if (publishNow) flush();
      else if (publishLater && !timer && !closed) timer = setTimeout(flush, 100);
      return effects;
    },
    state: () => state,
    close() { if (timer) clearTimeout(timer); timer = undefined; closed = true; },
  };
}
