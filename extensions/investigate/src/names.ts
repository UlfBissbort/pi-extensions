// Investigator names: drawn by the host from names.json, never issued twice in a
// session. Once every name is taken, numbered rounds follow: name_2, name_3, …
// Everything here is pure; the issued set is kept by the extension.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAMES: readonly string[] = JSON.parse(readFileSync(fileURLToPath(new URL('./names.json', import.meta.url)), 'utf8'));

export const firstPart = (name: string) => name.split('_')[0];

// Investigators running at the same time get different first parts where possible,
// so `@kepler…` stays unambiguous and parallel agents do not look alike.
export function pickName(pool: readonly string[], issued: ReadonlySet<string>, avoidFirst: ReadonlySet<string> = new Set(), random = Math.random): string {
  if (!pool.length) throw new Error('No investigator names configured');
  for (let round = 1; ; round++) {
    const candidates = pool.map(name => round === 1 ? name : `${name}_${round}`).filter(name => !issued.has(name));
    if (!candidates.length) continue;
    const preferred = candidates.filter(name => !avoidFirst.has(firstPart(name)));
    const from = preferred.length ? preferred : candidates;
    return from[Math.floor(random() * from.length)];
  }
}

// How the user may address an investigator: its exact name, or a unique prefix,
// optionally written with a trailing ellipsis (`@richard_the…`).
export type Resolved = { kind: 'one'; name: string } | { kind: 'none' } | { kind: 'ambiguous'; names: string[] };
export function resolveName(token: string, names: Iterable<string>): Resolved {
  const wanted = token.replace(/(?:\.\.\.|…)$/, '');
  const all = [...names];
  if (all.includes(wanted)) return { kind: 'one', name: wanted };
  const matches = wanted ? all.filter(name => name.startsWith(wanted)) : [];
  if (matches.length === 1) return { kind: 'one', name: matches[0] };
  return matches.length ? { kind: 'ambiguous', names: matches.sort() } : { kind: 'none' };
}

// `@name message`: the address and the message, or undefined for ordinary input.
export function parseAddress(text: string): { token: string; message: string } | undefined {
  const match = text.match(/^@([a-z0-9_]+(?:\.\.\.|…)?)[\s,:]+(\S[\s\S]*)$/);
  return match ? { token: match[1], message: match[2].trim() } : undefined;
}
