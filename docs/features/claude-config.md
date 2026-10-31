## #295 — ownership, wireframe and API contract (before implementation)

Owner: Codex chat 01a192bc-d6bb-7e50-a06e-55e7c1ef3521, branch `feat/295-claude-config`, independent clone. No conflicting PR/assignee found. Builds on main 0cad350; will integrate #391 auth before delivery.

Concrete read-only wireframe, extending Agent Config → Configurações:

```
Configurações do Claude                 [Esta máquina • somente leitura]
Projeto [known project selector]        Perfil [discovered profile selector]
Configuração efetiva: Desconhecida      Franquia: não comprovada
Arquivos atuais; não confirmam o que uma sessão carregou.

Modelo declarado | Subagentes declarados | Compactação declarada
Janela: desconhecida | Contexto atual: desconhecido | Até compactar: desconhecido

Camada             Caminho                             Estado
Usuário            <profile>/settings.json              lido/ausente/desconhecido
Projeto            <cwd>/.claude/settings.json           ...
Local              <cwd>/.claude/settings.local.json     ...
Gerenciada         <OS>/managed-settings.json + drop-ins ...
CLI / ambiente / políticas remotas e SO                  não observados
Desktop / .claude.json / .mcp.json                       separado, não mesclar como settings

Chave | Valor declarado seguro | Origem(s) | Sobrescritas | Confirmado no runtime
...   | •••• (valores livres)  | ...       | ...          | Desconhecido
```

Session detail adds “Configuração em vigor” linking the same read-only view with the session id; server resolves cwd/profile/machine from storage. Remote sessions display unavailable, without reading local files as remote. Codex remains #381.

Contract: `GET /api/agent-config/claude?project=<known>&profile=<discovered>` or `?session=<id>`, routed under existing authenticated agent-config prefix. No arbitrary file paths, writes, subprocesses, inference, credentials reads or remote calls. Values are projected to a conservative allowlist before serialization; commands, URLs, arbitrary strings and env values are masked on the server. Safe source/auth presence diagnostics only. `runtime.status=unknown`, `strictEligible=false` always; not billing admission evidence. #382 can consume this diagnostic without interpreting declared values as runtime proof.

File-level scalar/object precedence: user < project < local < managed file; arrays combine where documented, exceptional model/policy settings remain unresolved rather than claim unsupported effective values. Profiles are alternatives, never merged. CLI/env/MDM/server policy unobserved. Current files are not historical session snapshots. Window/token remaining unknown without runtime telemetry; never infer a window from a model name or turn percentage into an actual threshold. Desktop config is a separate source, not Claude Code settings precedence.

Official references checked 2026-10-31: https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/managed-settings ; https://code.claude.com/docs/en/model-config . Documentation changes by version; declarations and unknowns remain explicit.

## Implementation boundaries

This is a safe declaration inspector, not an implementation of the provider runtime. Files are current snapshots. Scalar model/environment declarations track file precedence and overwritten sources. Compound settings preserve every source and explicitly report unresolved semantics; raw arrays/commands/URLs and arbitrary field names are withheld, with opaque entry labels and structural counts. No inferred model window or compaction threshold is reported. Missing/inaccessible/invalid sources do not imply a clean configuration.

Profiles are discovered alternatives. A session can use an opaque known profile identity or a stored absolute transcript path under exactly one discovered profile; a relative import cursor without a proven root remains unknown. `.claude.json` global configuration and selected-project MCP, `.mcp.json` and macOS Desktop configuration are separate sources. Remote or non-Claude sessions return unavailable. MDM, server-managed policy, launch flags/environment, per-session runtime mutations and actual context measurements are unobserved. #382/#387 must continue refusing execution.

## Review and validation

Wireframe recorded before code: https://github.com/ahrenatechnology/ahrena-console/issues/295#issuecomment-6545936603

Review 1 (subagent `review_295_first`): changes requested for navigation, legacy session profile provenance, project-local MCP and generated English labels. All four addressed, with targeted regressions. Review is not GitHub approval.

Auth #391 and billing #389 integrated from main 450c323. The new endpoint is under the existing owner-authenticated prefix; no server/router authorization exception is added.

Initial targeted run: 62/63 passed; the CSS brand-token failure was corrected. Six added pure/fixture tests passed before the resource pause. Full local suite was invalidated by sandbox socket EPERM. Both test processes exited; logs preserved outside the repository. At TL request, no additional local suite/build or new subagent is started; final tests run serialized in GitHub CI.

Review 2 (same existing subagent, separate updated-diff pass under TL's one-review-slot resource limit): no remaining blocking findings. Rechecked all four fixes, auth integration, HTTP isolation tests and fail-closed semantics. No local commands/tests/builds ran in the review. This is not a GitHub approval; final HEAD CI remains mandatory.

Runtime evidence follow-up: #392 (P1), with dependencies, implementation steps and acceptance. It does not remove #387 or any runtime/billing gate.
