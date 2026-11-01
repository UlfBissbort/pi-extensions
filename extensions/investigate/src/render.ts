import { Text } from '@earendil-works/pi-tui';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { progressLines, safeDisplay, type InvestigationProgress } from './progress.ts';

export const renderInvestigationCall: NonNullable<ToolDefinition['renderCall']> = (args, theme, context) => {
  const title = theme.fg('toolTitle', theme.bold('investigate '));
  const input = args as { question?: unknown; scope?: unknown } | undefined;
  const question = safeDisplay(input?.question ?? 'Preparing question…');
  const scope = Array.isArray(input?.scope) && input.scope.length ? `\nScope: ${safeDisplay(input.scope.join(', '))}` : '';
  const text = `${title}${question}${scope}`;
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
  component.setText(text);
  return component;
};

export const renderInvestigationResult: NonNullable<ToolDefinition['renderResult']> = (result, options, theme, context) => {
  const details = result.details as { progress?: InvestigationProgress } | undefined;
  const progress = details?.progress;
  const lines = progress ? progressLines(progress, options.expanded) : [];
  if (!progress && options.isPartial) lines.push('Starting investigation…');
  if (!options.isPartial) {
    const answer = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const displayed = safeDisplay(answer);
    if (options.expanded) lines.push('', 'Final result:', displayed);
    else {
      const preview = displayed.slice(0, 600);
      lines.push('', preview + (displayed.length > preview.length ? '\n… Expand tool output for the complete answer and excerpts.' : ''));
    }
  }
  const color = context.isError ? 'error' : options.isPartial ? 'warning' : 'success';
  const text = lines.length ? [theme.fg(color, lines[0]), ...lines.slice(1)].join('\n') : '';
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
  component.setText(text);
  return component;
};
