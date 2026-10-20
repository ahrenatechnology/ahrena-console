// A fila das chamadas ao GitHub (decisão 0001, item 6): uma de cada vez, nunca em paralelo. Uma
// instância só no núcleo, dividida pelas leituras que chamam o GitHub por trás das telas (os
// repositórios e as instruções dos agentes), para uma não sobrepor chamadas à outra.

export class GithubCallQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Roda `fn` quando a chamada anterior, de quem for, terminou; a falha de uma não trava a próxima. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(fn);
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}
