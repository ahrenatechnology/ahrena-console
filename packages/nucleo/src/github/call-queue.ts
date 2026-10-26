// A fila das chamadas ao GitHub (decisão 0001, item 6). Uma instância só no núcleo, dividida pelas
// leituras que chamam o GitHub por trás das telas (os repositórios, as instruções dos agentes, a
// conexão), para uma não sobrepor chamadas à outra além do teto.
//
// #341: the core's queue lets `GITHUB_CALL_LIMIT` calls run at once (the list's count batches and
// the per-repository REST reads overlap); a queue built without a limit is still one at a time.

/** Calls to GitHub the core runs at the same time (#341). GitHub's secondary limit is 100. */
export const GITHUB_CALL_LIMIT = 4;

export class GithubCallQueue {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit = 1) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`GithubCallQueue: limit must be a positive integer, got ${limit}`);
    this.limit = limit;
  }

  /** Roda `fn` quando há vaga, na ordem de chegada; a falha de uma não trava a próxima. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++;
    // The slot is handed over by the call that ends (`running` stays the same).
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
