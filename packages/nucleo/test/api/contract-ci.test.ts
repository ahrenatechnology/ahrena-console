// #662/AC-2: a pull request runs Spectral on the contract with a committed ruleset at a pinned
// version, and oasdiff against the contract at the merge base. The runs themselves happen in CI; this
// test holds the workflow to what the criterion promises, so a change that unpins a version, drops a
// check, widens the token or lets untrusted input into a command fails here before it reaches CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { readJson } from './openapi-spec.ts';

const ROOT = new URL('../../../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/contract.yml', ROOT), 'utf8');
const rulesetFile = readJson(new URL('docs/contracts/core-api.spectral.json', ROOT));
if (typeof rulesetFile !== 'object' || rulesetFile === null) throw new Error('the Spectral ruleset is not an object');
const ruleset: { extends?: unknown; rules?: { [rule: string]: unknown } } = rulesetFile;

describe('#662/AC-2 the contract workflow', () => {
  test('#662/AC-2 Given a pull request, When CI runs, Then the contract workflow is triggered by it', () => {
    assert.match(workflow, /^on:\n(?:.*\n)*?\s+pull_request:/m);
    assert.doesNotMatch(workflow, /pull_request_target/, 'the workflow reads the pull request\'s own files: it must not run with the base\'s privileges');
  });

  test('#662/AC-2 the token is read-only and no step writes', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(workflow, /:\s*write\b/);
  });

  test('#662/AC-2 every action is pinned by commit', () => {
    const uses = [...workflow.matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1]!);
    assert.ok(uses.length >= 2);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  });

  test('#662/AC-2 Spectral lints the contract with the committed ruleset at an exact version, and a warning fails', () => {
    assert.match(workflow, /npx --yes @stoplight\/spectral-cli@\d+\.\d+\.\d+ lint docs\/contracts\/core-api\.openapi\.json --ruleset docs\/contracts\/core-api\.spectral\.json --fail-severity warn/);
    assert.match(workflow, /NPM_CONFIG_IGNORE_SCRIPTS: 'true'/);
  });

  test('#662/AC-2 the ruleset extends spectral:oas and turns no rule off', () => {
    assert.deepEqual(ruleset.extends, ['spectral:oas']);
    const off = Object.entries(ruleset.rules ?? {}).filter(([, v]) => v === 'off' || v === false);
    assert.deepEqual(off, [], 'a rule turned off needs its reason written next to it and this test updated');
  });

  test('#662/AC-2 oasdiff is an exact version, its download is checked by sha256, and it compares with the merge base', () => {
    assert.match(workflow, /OASDIFF_VERSION: '\d+\.\d+\.\d+'/);
    assert.match(workflow, /OASDIFF_SHA256: '[0-9a-f]{64}'/);
    assert.match(workflow, /sha256sum --check/);
    assert.match(workflow, /git merge-base/);
    assert.match(workflow, /oasdiff breaking [^\n]*--fail-on MISSING-VERSION-BUMP/);
    assert.match(workflow, /oasdiff breaking [^\n]*--allow-external-refs=false/, 'the spec is the pull request\'s: no external reference is followed');
  });

  test('#662/AC-2 no step puts text the pull request controls into a command', () => {
    const expressions = [...workflow.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!);
    for (const e of expressions) assert.match(e, /^(github\.event\.pull_request\.(base|head)\.sha|github\.ref|github\.event_name|matrix\.\w+)$/, e);
    assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{/, 'an expression inside a run line is shell injection');
  });
});
