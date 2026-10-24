#!/usr/bin/env node
// Fails a release build whose built-in GitHub OAuth Client ID is empty (#327): an installed app
// with no Client ID cannot run the device flow, and an end user must never be asked for it.
// Reads the constant from source, so it needs no build. Used by .github/workflows/app-release.yml.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'packages/nucleo/src/github/connection/device-flow.ts');
const match = /export const GITHUB_OAUTH_CLIENT_ID = '([^']*)';/.exec(readFileSync(file, 'utf8'));
if (!match) {
  console.error(`::error::GITHUB_OAUTH_CLIENT_ID não foi encontrado em ${file}.`);
  process.exit(1);
}
if (!match[1].trim()) {
  console.error('::error::GITHUB_OAUTH_CLIENT_ID está vazio: o app publicado não consegue conectar ao GitHub. Ponha o Client ID do OAuth App da Ahrena em packages/nucleo/src/github/connection/device-flow.ts (#327).');
  process.exit(1);
}
console.log('GITHUB_OAUTH_CLIENT_ID presente.');
