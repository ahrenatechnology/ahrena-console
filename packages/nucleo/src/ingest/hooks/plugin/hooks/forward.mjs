#!/usr/bin/env node
// Encaminhador dos hooks do Claude Code para o núcleo do Ahrena Console.
//
// Lê o payload do stdin e faz POST em `${AHRENA_CONSOLE_URL}/api/hooks`. Nunca atrapalha a sessão:
// - não escreve nada no stdout (no SessionStart e no UserPromptSubmit o stdout vira contexto do modelo);
// - sai sempre com código 0, mesmo com o núcleo fora;
// - desiste depois de AHRENA_CONSOLE_HOOK_TIMEOUT_MS (padrão 800 ms), somando leitura e envio;
// - registra a falha numa linha de log, que o `doctor` (item 1.8) vai ler.
//
// Junto do payload vai o campo `ahrena_console.env`, com a pasta de configuração e a conta e a org do
// ambiente (decisão 0006): só `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` e
// `CLAUDE_CODE_ORGANIZATION_UUID`, mais `ssh: true` quando o hook roda numa sessão SSH (só a presença
// de `SSH_CONNECTION`, nunca o valor). Nenhuma outra variável, e nunca token ou chave.
//
// JavaScript puro e sem dependências, para rodar em qualquer Node >= 18 sem o núcleo instalado.

import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const env = process.env;
const base = (env.AHRENA_CONSOLE_URL || `http://127.0.0.1:${env.AHRENA_CONSOLE_PORT || 4720}`).replace(/\/+$/, '');
const timeoutMs = Number(env.AHRENA_CONSOLE_HOOK_TIMEOUT_MS) || 800;
const logPath = env.AHRENA_CONSOLE_HOOK_LOG || join(homedir(), '.ahrena-console', 'hooks.log');
const MAX_BODY = 1024 * 1024;
const MAX_LOG = 256 * 1024;
const firedAt = new Date().toISOString();
const deadline = Date.now() + timeoutMs;

function record(message) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (statSync(logPath).size > MAX_LOG) truncateSync(logPath, 0);
    } catch {
      // arquivo ainda não existe
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // sem onde registrar, segue em silêncio
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish('stdin não fechou a tempo'), Math.max(deadline - Date.now(), 0));
    function finish(problem) {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve({ body: Buffer.concat(chunks).toString('utf8'), problem });
    }
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return finish('payload maior que 1 MiB, descartado');
      chunks.push(chunk);
    });
    process.stdin.on('end', () => finish(null));
    process.stdin.on('error', (err) => finish(`erro no stdin: ${err.message}`));
  });
}

/** Variáveis do ambiente que vão para o núcleo; nenhuma outra sai daqui. */
const CONTEXT_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID'];

/** Acrescenta `ahrena_console.env` ao payload; se ele não for um objeto JSON, segue como veio. */
function withContext(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;
  const context = {};
  for (const name of CONTEXT_VARS) if (env[name]) context[name] = env[name];
  if (env.SSH_CONNECTION) context.ssh = true;
  return JSON.stringify({ ...payload, ahrena_console: { env: context } });
}

function eventName(body) {
  const m = /"hook_event_name"\s*:\s*"([A-Za-z0-9]+)"/.exec(body);
  return m ? m[1] : 'desconhecido';
}

async function main() {
  const { body, problem } = await readStdin();
  if (problem) return record(`${eventName(body)} não enviado: ${problem}`);
  if (!body.trim()) return record('hook sem payload, nada a enviar');
  try {
    const res = await fetch(`${base}/api/hooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ahrena-delivery-id': randomUUID(),
        'x-ahrena-hook-at': firedAt,
      },
      body: withContext(body),
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 50)),
    });
    if (!res.ok) record(`${eventName(body)} recusado pelo núcleo: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    const cause = err?.cause?.code || err?.name || 'erro';
    record(`${eventName(body)} não enviado a ${base}: ${cause}`);
  }
}

main()
  .catch((err) => record(`falha inesperada: ${err?.message ?? err}`))
  .finally(() => process.exit(0));
