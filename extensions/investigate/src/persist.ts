// Agent records in the parent session, so investigators survive a reload. Each
// save is a custom session entry (not model context) holding only the entries
// added since the previous save; loading concatenates them in order. Pure: the
// extension writes the deltas and reads the session entries.
import type { Entry, InvestigationAgent, Uid } from './agent.ts';

export const AGENT_ENTRY = 'investigation-agent';
export type AgentDelta = { uid: Uid; from: number; entries: Entry[] };

// What to save so the session holds the whole record, or undefined when it already does.
export function delta(agent: InvestigationAgent, saved: number): AgentDelta | undefined {
  return agent.context_.length > saved ? { uid: agent.__uid, from: saved, entries: agent.context_.slice(saved) } : undefined;
}

// Agents from the session entries of the active branch, most recently saved last.
// A delta applies only where its record left off, so a branch that diverged from
// the saved history cannot interleave two pasts.
export function loadAgents(entries: readonly unknown[]): InvestigationAgent[] {
  const agents = new Map<Uid, InvestigationAgent>();
  for (const entry of entries) {
    const e = entry as { type?: string; customType?: string; data?: AgentDelta };
    if (e.type !== 'custom' || e.customType !== AGENT_ENTRY || !e.data?.uid || !Array.isArray(e.data.entries)) continue;
    const { uid, from, entries: added } = e.data;
    const known = agents.get(uid) ?? { __type: 'ET.InvestigationAgent' as const, __uid: uid, context_: [] };
    if (known.context_.length !== from) continue;
    agents.delete(uid);
    agents.set(uid, { ...known, context_: [...known.context_, ...added] });
  }
  return [...agents.values()];
}
