# Codex configuration inspection (#381)

Contract v1, read-only, documented 2026-10-31. `GET /api/agent-config/codex`
uses the existing owner-auth boundary. Query: known project, opaque profile ID,
optional observed session ID. Remote/non-Codex sessions return unavailable without
reading local config. A session has no proven Codex home/profile yet: host user
config is not attributed to it. Project declarations remain current-file evidence,
not evidence of what a session loaded. No runtime changes (#383).

## Wireframe

```
Configurações do Codex                         [Claude] [Atualizar]
[Projeto conhecido v] [Perfil para inspeção v]   (selection never activates it)
Configuração efetiva: desconhecida
Execução estrita permanece bloqueada
Declarações por origem: chave | declaração | origem | efetiva desconhecida
Camadas e fontes: sistema / usuário / perfil / projeto
Instruções, skills e MCP encontrados: ID opaco | origem | presença | aplicação desconhecida
```

Agent Config links to this provider-specific screen; observed Codex session links
preserve provider and remote context. Existing Claude routes, editing and policy
are unchanged. All configuration actions are GET. No config/plugin writes or
provider/helper/MCP execution. Tool catalog discovers Codex via filesystem PATH
lookup, never `codex --version`; only an adjacent validated npm package.json can
supply a declared installed package version. Native executable versions remain
unknown. Package version does not prove the version used by a session.

## Evidence and limits

[Official precedence](https://developers.openai.com/codex/config-basic): system,
cloud defaults, user, profile, trusted project root-to-cwd, CLI (ascending).
Cloud defaults, requirements, trust, CLI/environment overrides and runtime are
not observed. No merge is labeled effective. The nearest `.git` marker bounds
ancestor scanning; without it only cwd is inspected and root is unknown.

[Official profiles](https://developers.openai.com/codex/config-advanced): since
0.134, separate `name.config.toml` files replace inline `[profiles.name]` and the
legacy `profile` selector. Both forms are listed with version-dependent labels;
no default selection is inferred and no version support is fabricated.

[Instructions](https://developers.openai.com/codex/guides/agents-md) are native
AGENTS.md / AGENTS.override.md candidates; no CLAUDE.md import warning or @import
resolution. Presence is not proof of loading, empty/overridden/truncated files can
be ignored by Codex. Custom instruction paths and fallback names are not followed.
[Skills](https://developers.openai.com/codex/skills) enumerate user `.agents/skills`,
repository root-to-cwd `.agents/skills`, and `/etc/codex/skills`. Plugin/bundled
skills and linked folders are not resolved. MCP lists declarations, not discovered
server tools or connected status. Limits (1 MiB/file, 200 entries, 32 ancestors)
and failed reads produce unknown/incomplete diagnostics.

Free values, arbitrary keys, profile names, MCP names and skill names do not leave
the API. Opaque IDs preserve identity; instruction and skill prose is never read.
Enums and bounded numeric settings are allowlisted. Auth/token files are never
opened. Parser errors are discarded, not logged. Reads reject final symlinks,
hardlinks, special files and oversized files. Declared assets remain unknown for
session applicability. Runtime and strict billing eligibility stay unknown/false.

## Parser distribution

`src/vendor/smol-toml` is the unmodified ESM distribution of smol-toml 1.4.2,
BSD-3-Clause (adjacent LICENSE), npm tarball SHA-1
`46c4dcc71f982040085ee54b22377c96a4597ce3`. Vendored because the native desktop
bundle ships `src/` without node_modules. No dependency install or provider
execution is needed to inspect TOML; no hand-written partial TOML grammar.

## Verification

CI runs provider config/HTTP isolation, malformed/missing config, secret-bearing
keys/values, profile formats, instruction provider semantics, passive catalog
probe, process classification, Claude regressions and owner-auth tests. Fixtures
are synthetic. No local builds or suites were run per machine resource constraint.
