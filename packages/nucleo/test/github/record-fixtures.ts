// Records real GitHub responses for the tests (few calls, serially, with a pause).
// Usage: node test/github/record-fixtures.ts > test/github/fixtures/responses.json
// It also checks end to end: prints the cost of each query to stderr.

import { ghCliToken, GithubCache, GithubGraphqlSource, GithubWork, MemoryCacheStore } from '../../src/index.ts';

const REPO = 'ahrenatechnology/ahrena-console';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const recorded: { operation: string; variables: unknown; status: number; body: unknown }[] = [];

const recordingFetch: typeof fetch = async (url, init) => {
  await sleep(3000);
  const res = await fetch(url, init);
  const text = await res.text();
  const { query, variables } = JSON.parse(String(init?.body));
  const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '?';
  recorded.push({ operation, variables, status: res.status, body: JSON.parse(text) });
  return new Response(text, { status: res.status, headers: res.headers });
};

const source = new GithubGraphqlSource({
  token: ghCliToken,
  fetch: recordingFetch,
  onCost: (c) => console.error(`${c.operation}: custo ${c.cost}, restam ${c.remaining}`),
});
const work = new GithubWork({ source, cache: new GithubCache({ store: new MemoryCacheStore() }), filter: `repo:${REPO} is:issue is:open` });

const tree = await work.tree();
console.error(`árvore: ${tree.count} nós, ${tree.roots.length} raízes, stale=${tree.stale}`);
const epic = await work.expand(`${REPO}#6`);
console.error(`épico #6: ${epic?.children.length} filhas, detalhe=${epic?.detail?.stage}`);
const withPr = epic?.children.find((c) => c.detail?.pullRequests.length);
console.error(`filha com PR: ${withPr?.key} → ${JSON.stringify(withPr?.detail)}`);
// Lote de pais: uma issue fechada (sobe até a iniciativa) e uma que não existe.
const chain = await source.nodes([`${REPO}#40`, `${REPO}#99999`]);
console.error(`lote de pais: ${chain.map((n) => n.number).join(' → ')}`);
console.log(JSON.stringify(recorded, null, 1));
