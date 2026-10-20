# 0003 · Log de eventos

- **Status:** proposta
- **Data:** 2026-06-01
- **Substitui:** [0002](0002-event-queue.md)

## Contexto

A fila não reproduz eventos para consumidores novos.

## Decisão

Um log de eventos com retenção de 30 dias.

## Opções

1. **Manter a fila.** Não reproduz.
2. **Log de eventos.** Reproduz por 30 dias.

## Consequências

Cada consumidor guarda a sua posição.
