// Read-only diagnostic entry point. No provider process, inference, login or credential reads.
import { diagnoseBilling } from './auth-probes.ts';
import { evaluateBillingAdmission } from './billing-policy.ts';
import { isAbsolute } from 'node:path';

const [provider, configDir, cwd = process.cwd()] = process.argv.slice(2);
if ((provider !== 'claude' && provider !== 'codex') || !configDir || !isAbsolute(configDir) || !isAbsolute(cwd)) {
  console.error('Uso: node src/runtime/billing-diagnostic-cli.ts <claude|codex> <pasta absoluta de configuração> [pasta absoluta do projeto]');
  process.exitCode = 2;
} else {
  const scope = { provider, profileId: 'local-diagnostic', accountId: null, configDir, cwd };
  try {
    const diagnostic = await diagnoseBilling(scope);
    // Do not print local paths, profile identity, raw config, environment or status output.
    console.log(JSON.stringify(evaluateBillingAdmission(scope, diagnostic), null, 2));
    process.exitCode = 1; // Unknown is a refusal, not success.
  } catch {
    console.error('Diagnóstico indisponível. Execução gerenciada permanece recusada.');
    process.exitCode = 1;
  }
}
