import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerInvestigation } from './src/extension.ts';

export default async function investigateExtension(pi: ExtensionAPI) {
  await registerInvestigation(pi, dirname(fileURLToPath(import.meta.url)));
}
