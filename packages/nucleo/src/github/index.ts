// Trabalho do GitHub (item 5.2): hierarquia iniciativa → épico → item → plano, com PR,
// CI e review por item, e o kanban de um Project (item 5.3), pela decisão 0001. Ver README
// do pacote, seção "Trabalho do GitHub".

import { GithubCache, MemoryCacheStore, type CachePort } from './cache.ts';
import { ghCliToken, GithubGraphqlSource, type GithubGraphqlSourceOptions } from './github-source.ts';
import { GithubWork } from './work-service.ts';

export * from './work.ts';
export * from './tree.ts';
export * from './cache.ts';
export * from './source.ts';
export * from './github-source.ts';
export * from './sqlite-cache.ts';
export * from './work-service.ts';
export * from './project.ts';

export interface CreateGithubWorkOptions extends Partial<GithubGraphqlSourceOptions> {
  /** Busca do GitHub, ex.: `repo:dono/repo is:issue is:open`. */
  filter: string;
  /** Onde o cache fica; o padrão é memória. No núcleo local, `new SqliteCacheStore(storage.db)`. */
  store?: CachePort;
}

/** Monta o serviço com o adaptador GraphQL (token do `gh` por padrão) e o cache. */
export function createGithubWork({ filter, store = new MemoryCacheStore(), token = () => ghCliToken(), now, ...rest }: CreateGithubWorkOptions): GithubWork {
  const source = new GithubGraphqlSource({ token, now, ...rest });
  const cache = new GithubCache({ store, now });
  return new GithubWork({ source, cache, filter, now });
}
