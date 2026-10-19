# Ahrena Console

Console para ver e controlar as sessões e os agentes do Claude Code, de dentro do Claude Desktop.

**Versão 0.0.1, em concepção.** Ainda não tem código: este repositório começa pelo benchmark e pelas decisões.

## Premissas

- **MCP first.** Tudo que o console sabe e faz passa por um servidor MCP. O Claude consulta e age por ele na conversa.
- **Dentro do Claude Desktop.** A interface principal abre no próprio app: artefato, painel ou UI inline. Nada de depender de terminal ou TUI.
- **Standalone é opcional.** Pode existir uma interface web separada, mas ela não é o centro.
- **Projeto novo.** Podium e Claude Code Agent Monitor são referências de ideias, não base de código.
- **Interface e marca.** Visual na linha do Claude Code Agent Monitor, com a marca da Ahrena (a mesma do The Forward Deployed Engineer). Detalhes em [docs/design.md](docs/design.md).

## Em aberto

- Onde roda: só local, só nuvem, ou híbrido (agente local em cada máquina mais um hub para time e clientes).
- Escopo da 0.0.1: uso interno da Ahrena ou já com clientes.
- Se os agentes headless de produção entram na 0.0.1.

## Proposta

[docs/proposta-0.0.1.md](docs/proposta-0.0.1.md): arquitetura da 0.0.1 (local-first, núcleo único, superfícies no Claude Desktop) e o recorte de features.

## Backlog

[docs/backlog-0.0.1.md](docs/backlog-0.0.1.md): a 0.0.1 na linha do Claude Code Agent Monitor, local primeiro (M1) e AWS serverless em seguida (M2).

## Validações

[docs/validacoes-0.0.1.md](docs/validacoes-0.0.1.md): o que funcionou nos testes de painel, artefato, UI inline e ferramentas internas do Desktop. O código dos testes está em [spikes/](spikes/).

## Benchmark

O estudo das referências fica num repositório interno da Ahrena. Os documentos daqui o citam como "benchmark interno".

## Licença

[Apache-2.0](LICENSE). Copyright 2026 Ahrena.
