// Grava a leitura real do kanban de um Project para os testes: uma chamada só, sem mutação.
// Uso: node test/github/gravar-project.ts > test/github/fixtures/project.json
// Imprime no stderr o custo e as raias.

import { ghCliToken, GithubProjectSource, toLanes } from '../../src/index.ts';

const recorded: { operation: string; variables: unknown; status: number; body: unknown }[] = [];

const recordingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  const { query, variables } = JSON.parse(String(init?.body));
  const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '?';
  recorded.push({ operation, variables, status: res.status, body: JSON.parse(text) });
  return new Response(text, { status: res.status, headers: res.headers });
};

const source = new GithubProjectSource({
  token: ghCliToken,
  fetch: recordingFetch,
  onCost: (c) => console.error(`${c.operation}: custo ${c.cost}, restam ${c.remaining}`),
});
const board = await source.board({ owner: 'ahrenatechnology', number: 3 });
console.error(`${board.title}: ${board.items.length} itens; ${toLanes(board).map((l) => `${l.name} ${l.items.length}`).join(' · ')}`);
console.log(JSON.stringify(recorded, null, 1));
