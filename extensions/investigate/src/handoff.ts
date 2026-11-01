// Pure reporting projections. Never change the research prefix or execute tools.
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { currentRun, handoffOf, lastRequest, render, SUBMIT, turnsInRun, type Handoff, type InvestigationAgent } from './agent.ts';

export const HANDOFF_MARKER = 'INVESTIGATION STOPPED BY THE USER — HANDOFF ONLY';
const publicContent = (content: AssistantMessage['content']) => content.filter(b => b.type !== 'thinking');
export function handoffInstruction(agent: InvestigationAgent, trigger: Handoff['trigger']): string {
  const ended = currentRun(agent).find(e => e.__type === 'ET.RunEnded');
  return `════════════════════════════════════════════════════════════\n${HANDOFF_MARKER}\n════════════════════════════════════════════════════════════\nThe human user stopped this investigation with ${trigger}. Research execution has ended. This is a separate reporting phase, not permission to resume research.\n\nInterrupted assignment (task data):\n${JSON.stringify(lastRequest(agent)?.request, null, 2)}\n\n${ended?.__type === 'ET.RunEnded' && ended.partial?.length ? `Interrupted output (incomplete, unverified; proposed calls were not executed):\n${JSON.stringify(publicContent(ended.partial))}\n\n` : ''}Write a useful, concise handoff to the parent agent from the full history above. State what you were doing, verified findings and their evidence, uncertainties, and unfinished work. Distinguish tool calls that completed from those not executed or interrupted. If no useful findings exist, say so. Do not expose private reasoning.\n\nDO NOT call tools, continue research, or request additional evidence. Return the handoff as plain text. The original task and tools remain in the history only to preserve context. This reporting instruction supersedes the earlier requirement to use submit_answer.`;
}
export const handoffContext = (agent: InvestigationAgent, instruction: string, timestamp: number): Context => ({
  messages: [...render(agent).messages, { role: 'user', content: [{ type: 'text', text: instruction }], timestamp }],
});
export function activityLog(agent: InvestigationAgent): string {
  const entries = currentRun(agent);
  const lines = [`Task: ${JSON.stringify(lastRequest(agent)?.request)}`, `${turnsInRun(agent)} research model requests (including interrupted requests).`, 'Activity log (not a verified findings summary):'];
  for (const [index, entry] of entries.entries()) {
    if (entry.__type !== 'ET.LLMResponse') continue;
    for (const block of entry.content) {
      if (block.type !== 'toolCall') continue;
      const nextResponse = entries.findIndex((e, i) => i > index && e.__type === 'ET.LLMResponse');
      const result = entries.slice(index + 1, nextResponse < 0 ? undefined : nextResponse).find(e => e.__type === 'ET.ToolResult' && e.toolCallId === block.id);
      const outcome = result?.__type === 'ET.ToolResult' ? result.isError ? 'failed or interrupted' : 'completed' : 'not executed';
      lines.push(`- ${block.name} ${JSON.stringify(block.arguments)}: ${outcome}`);
    }
  }
  const end = entries.find(e => e.__type === 'ET.RunEnded');
  if (end?.__type === 'ET.RunEnded' && end.partial?.length) lines.push(`Interrupted output (unverified): ${JSON.stringify(publicContent(end.partial))}`);
  const text = lines.join('\n');
  return text.length <= 16000 ? text : `${text.slice(0, 15900)}\n[Activity log shortened; the full record remains with the investigator.]`;
}
export function summaryText(response: AssistantMessage): string | undefined {
  if (response.stopReason === 'error' || response.stopReason === 'aborted') return undefined;
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (text) return text;
  const submit = response.content.find(b => b.type === 'toolCall' && b.name === SUBMIT);
  return submit?.type === 'toolCall' && typeof submit.arguments.text === 'string' && submit.arguments.text.trim() ? submit.arguments.text : undefined;
}
export function handoffResultText(agent: InvestigationAgent | undefined, notice: string): string {
  const handoff = handoffOf(agent);
  return handoff ? `${notice} with ${handoff.trigger}. Partial work, not a completed investigation.\n\n${handoff.outcome === 'fallback' ? `Handoff unavailable: ${handoff.error}.\n\n` : ''}${handoff.text}` : notice;
}
export function handoffDetails(agent?: InvestigationAgent) {
  const h = handoffOf(agent);
  if (!h) return undefined;
  const total = h.usage.input + h.usage.cacheRead + h.usage.cacheWrite;
  return { outcome: h.outcome, usage: h.usage, input: h.usage.input, cacheRead: h.usage.cacheRead, cacheReadRatio: total ? h.usage.cacheRead / total : 0 };
}
