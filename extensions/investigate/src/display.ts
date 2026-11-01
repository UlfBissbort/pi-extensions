// The tool display in the Elm style. Pi gives every tool display a persistent
// state object; DisplayState lives there. Every change is a DisplayEvent applied
// by reduceDisplay, which also returns the commands the edge executes. What is
// visible is derived from DisplayState by renderDisplay (render.ts).
import type { Snapshot, StepId } from './run.ts';

export const RESULT_ID: StepId = 'result';

export type DisplayState = {
  snapshot?: Snapshot;                          // latest data from the worker, via tool details
  final?: { text: string; failed: boolean };    // the result returned to the parent
  open: ReadonlySet<StepId>;                    // per-step overrides of defaultOpen
  defaultOpen: boolean;                         // mirrors Pi's expand-tool-output toggle
};

export type DisplayEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'final'; text: string; failed: boolean }
  | { type: 'toggle'; id: StepId }
  | { type: 'defaultOpen'; value: boolean };

export type DisplayCommand =
  | { type: 'holdScroll' }     // before the redraw, keep the transcript where it is
  | { type: 'redraw' };        // ask Pi to render this display again

export const initDisplay = (defaultOpen: boolean): DisplayState => ({ open: new Set(), defaultOpen });

const toggle = (open: ReadonlySet<StepId>, id: StepId): ReadonlySet<StepId> => {
  const next = new Set(open);
  if (!next.delete(id)) next.add(id);
  return next;
};

export function reduceDisplay(state: DisplayState, event: DisplayEvent): [DisplayState, DisplayCommand[]] {
  switch (event.type) {
    // Pi redraws on its own after renderResult; no command needed.
    case 'snapshot': return [{ ...state, snapshot: event.snapshot }, []];
    case 'final': return [{ ...state, final: { text: event.text, failed: event.failed } }, []];
    case 'toggle': return [{ ...state, open: toggle(state.open, event.id) }, [{ type: 'holdScroll' }, { type: 'redraw' }]];
    // Opening or closing all clears the overrides, so "all" means all.
    case 'defaultOpen': return event.value === state.defaultOpen
      ? [state, []]
      : [{ ...state, defaultOpen: event.value, open: new Set() }, [{ type: 'holdScroll' }]];
  }
}

// An override flips the default for that step only.
export const isOpen = (state: DisplayState, id: StepId) => state.open.has(id) !== state.defaultOpen;

// What Pi's renderResult arguments mean, as events. Pi calls renderResult for
// every partial update, for the final result, and when its expanded flag changes.
export type RenderInput = { snapshot?: Snapshot; text: string; isPartial: boolean; isError: boolean; expanded: boolean };
export function eventsFromRender(state: DisplayState, input: RenderInput): DisplayEvent[] {
  const events: DisplayEvent[] = [];
  if (input.snapshot && input.snapshot !== state.snapshot) events.push({ type: 'snapshot', snapshot: input.snapshot });
  if (!input.isPartial && (state.final?.text !== input.text || state.final.failed !== input.isError)) {
    events.push({ type: 'final', text: input.text, failed: input.isError });
  }
  if (input.expanded !== state.defaultOpen) events.push({ type: 'defaultOpen', value: input.expanded });
  return events;
}

export function reduceAll(state: DisplayState, events: DisplayEvent[]): [DisplayState, DisplayCommand[]] {
  const commands: DisplayCommand[] = [];
  for (const event of events) {
    const [next, more] = reduceDisplay(state, event);
    state = next;
    commands.push(...more);
  }
  return [state, commands];
}
