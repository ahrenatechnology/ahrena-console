# 0001 · SQLite em memória nos testes

- **Status:** aceita
- **Data:** 02/03/2026
- **Substitui:** nada
- **Mexe em:** [0002](0002-fila-de-eventos.md)

## Contexto

A suíte sobe um Postgres e leva quatro minutos.

## Decisão

Os testes usam SQLite em memória.

## Alternativas consideradas

- **Postgres no Docker.** Igual à produção, mas lento.
- **Repositório falso.** Rápido, mas não testa o SQL.

## Consequências

A suíte roda em 40 s.
