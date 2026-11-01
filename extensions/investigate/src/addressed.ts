import { parseAddress, resolveName } from './names.ts';
import { currentRun, isUserStop, status, turnsInRun, type InvestigationAgent } from './agent.ts';
import { snapshot, type RunState } from './run.ts';

export const STOP_MESSAGE = 'Stopped by the user';
export const HARD_STOP_MESSAGE = 'Hard-stopped by the user';
export function parseAddressed(text: string) {
  const address = parseAddress(text);
  if (!address) return undefined;
  const command = address.message.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|$)([\s\S]*)$/);
  if (!command) return { ...address, kind: 'message' as const };
  const name = command[1];
  const error = name !== 'stop' && name !== 'stopp' && name !== 'status' ? `Unknown investigator command: /${name}. Use /stop, /stopp or /status.`
    : command[2].trim() ? `Usage: @name /${name} (no arguments).` : undefined;
  return { ...address, kind: 'command' as const, command: name, error };
}

export function commandCompletion(lines: string[], row: number, col: number, names: Iterable<string>) {
  const match = row === 0 ? (lines[0] ?? '').slice(0, col).match(/^@([a-z0-9_]+(?:\.\.\.|…)?)[\s,:]+(\/[a-z]*)$/) : null;
  if (!match || resolveName(match[1], names).kind !== 'one') return undefined;
  const items = ['/stop', '/stopp', '/status'].filter(value => value.startsWith(match[2])).map(value => ({ value, label: value, description: value === '/stop' ? 'Finish the current operation, then hand off' : value === '/stopp' ? 'Abort immediately, then hand off' : 'Show local investigator status' }));
  return items.length ? { prefix: match[2], items } : undefined;
}
export function applyCommand(lines: string[], col: number, value: string, prefix: string) {
  const inserted = lines[0].slice(0, col - prefix.length) + value + ' ';
  return { lines: [inserted + lines[0].slice(col).replace(/^ /, ''), ...lines.slice(1)], cursorLine: 0, cursorCol: inserted.length };
}
export function statusText(name: string, state?: RunState, agent?: InvestigationAgent, active = false) {
  agent = state?.agent ?? agent;
  const stopped = isUserStop(state?.stop?.reason);
  const phase = active ? state?.awaiting === 'handoff' ? 'handing off' : stopped ? state?.stop?.reason === 'user_hard_stopped' ? 'stopping now' : 'stopping' : state?.phase === 'starting' ? 'queued (starting)' : state?.phase : agent ? status(agent) : 'not running';
  const end = agent && currentRun(agent).reverse().find(e => e.__type === 'ET.RunEnded');
  const count = state ? snapshot(state).turns + (state.awaiting === 'model' && !state.streaming ? 1 : 0) : agent ? turnsInRun(agent) : 0;
  return `${name}: ${phase} · ${active ? '' : 'last run: '}${count} model requests · operation: ${active ? state?.awaiting ?? state?.phase ?? 'none' : 'none'} · unread: ${state?.inbox?.length ?? 0}${stopped ? ` · ${state?.stop?.message}` : end?.__type === 'ET.RunEnded' ? ` · ${end.message ?? end.reason}` : ''}`;
}
export const unreadStopped = (messages: string[]) => messages.length ? `\n\nThese user messages were not read and will not automatically resume the investigator:\n${messages.map(m => `- ${JSON.stringify(m)}`).join('\n')}` : '';
