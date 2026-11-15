# Delegations contract (#567)

Handing an open saturation alert to a new Claude session (epic #563; wireframe screen 566-17, gaps D7 and D8). Two operations: the preview of the prompt, then the opening. The vocabulary is `packages/nucleo/src/delegation/` (`model.ts`, `prompt.ts`, `delegate.ts`, `preview-store.ts`); the openers are `packages/nucleo/src/api/delegation-launch.ts`; the routes are `packages/nucleo/src/api/delegations.ts`; the acceptance test is `packages/nucleo/test/api/delegations-api.test.ts`, which also checks that the statuses and reasons below are exactly the ones the routes answer.

The core never runs the prompt, never kills a process and never deletes data. It opens a session; the person reads, edits and sends the prompt there.

## Operation: preview

`GET /api/delegations/preview?machine=<id>&alert=<alertId>`

- `machine` and `alert` follow the rules of `GET /api/diagnosis` (docs/contracts/diagnosis.md): each required, exactly once; `machine` a machine id, `alert` the id of an alert open on it (URL-encoded, at most 200 characters, no control character).
- The prompt is built from the open alert and its diagnosis (the same read as `GET /api/diagnosis`, a remote machine's through its tunnel). A diagnosis that cannot be read, or an alert whose kind has no diagnosis, is not an error: the prompt says there is none.
- The preview is held in memory, one per machine and alert (the last one), for 10 minutes and at most 50 at a time.

### Response `200`

```json
{ "prompt": "...", "size": 3120, "truncated": false, "takenAt": "2026-11-14T12:00:00.000Z" }
```

- `prompt` is the exact text a delegation will send.
- `size` is `encodeURIComponent(prompt).length`, which is what the Desktop address budget (12 000) measures. `truncated` is `true` when the diagnosis was summarised to fit; the prompt then names what was left out.
- `takenAt` is the diagnosis moment (the diagnosis' own `takenAt`), or the current instant when there is no diagnosis. The POST carries it back (D7).

### Statuses

| Status | When |
| --- | --- |
| `200` | The preview, above. |
| `400` | `machine` or `alert` missing, repeated, empty, too long or not valid. `{ error }`. |
| `404` | `{ error, reason }` with `reason` `unknown-machine` or `alert-not-open`. |
| `405` | A method other than `GET`. |
| `501` | `{ "error": "delegation-unsupported" }`, stable: this núcleo has no delegation wired (the demo). |

## Operation: open

`POST /api/delegations`, `Content-Type: application/json`, no query string.

```json
{ "machine": "local", "alertId": "swap-high", "via": "desktop", "takenAt": "2026-11-14T12:00:00.000Z" }
```

- `machine` and `alertId` as above; `takenAt` the value the preview answered (an ISO instant, at most 64 characters); `via` one of `desktop`, `terminal`, `ssh`.
- D8, the vias a machine takes: `local` ("Esta máquina") takes `desktop` or `terminal`; any other machine (the Workstation, through its tunnel) takes `ssh` only. Another `via` is `400`.
- D7, the `takenAt` rule: the prompt that is sent is the one the last preview of that machine and alert held, never a rebuilt one. When no preview is held (never taken, expired, or replaced by a newer preview with another `takenAt`) or its `takenAt` is not the one in the body, the answer is `409` and nothing opens: the screen asks for the preview again. The alert must still be open when the POST arrives.
- A preview stays held after it opened a session, until it expires or is replaced: the same POST again opens the same prompt again.

### Response `200`

```json
{ "ok": true, "opened": "desktop" }
```

`opened` is the `via` that was opened.

### What each via does

- `desktop`: opens `claude://code/new?folder=<folder>&q=<prompt>` through the Claude Desktop (`open`, the address as one argument). The Desktop pre-fills the composer; the person sends it. `<folder>` is the home folder of the user the core runs as. Only on macOS with the Claude Desktop.
- `terminal` (this machine): the prompt goes on the Mac clipboard (`pbcopy`, the text on stdin), a Terminal window opens in the home folder, prints the prompt (every terminal control character shown as `\uXXXX`), and starts `claude` with no prompt: the person pastes and sends. The `claude` command has no pre-fill flag, and `claude "<prompt>"` would send it, so the prompt is never an argument.
- `ssh` (the Workstation): first a pre-flight, `ssh -o BatchMode=yes -o ConnectTimeout=5 ahrena-workstation true`; if it passes, the same clipboard handoff opens a Terminal window that runs `ssh -t ahrena-workstation claude`, so the session runs on the Workstation, in its home folder, with no prompt. The SSH host is fixed (`ahrena-workstation`): nothing in the request chooses it.
- Nothing is run through a shell string by the core: every program starts with an argument list; the prompt lives only on the clipboard, in a private (0600) file the Terminal window prints and removes, and in the memory of the core.

### Statuses

| Status | When |
| --- | --- |
| `200` | The session opened. |
| `400` | A body field is missing or invalid (`machine`, `alertId`, `takenAt`, `via`), or a `via` the machine does not take; the `error` says which `via`s it takes. `{ error }`. |
| `403` | A query string on the POST. |
| `404` | `{ error, reason }` with `reason` `unknown-machine` or `alert-not-open` (the alert closed since the preview). |
| `405` | A method other than `POST`. |
| `409` | `{ error, reason }` with `reason` `diagnosis-changed`: no preview is held for that machine and alert, it expired, or its `takenAt` is not the one sent. |
| `413` | The body is larger than the limit. |
| `415` | `Content-Type` is not `application/json`. |
| `422` | `{ error, reason }` with `reason` `too-large`: the held prompt no longer fits the Desktop address (`via` `desktop` only). |
| `501` | `{ error }`: no way to open here (no Claude Desktop, no terminal the core can open, or not macOS); the body is `error` only, the screen holds the prompt from the preview. `{ "error": "delegation-unsupported" }`, stable, when this núcleo has no delegation wired. |
| `502` | `{ error, reason }`: `ssh-unreachable` or `ssh-timeout` (the pre-flight failed; the screen offers "Copiar o prompt"), or `open-failed` (opening threw). |

The answers carry a pt-BR `error` and a stable `reason`, never a dependency's own text: the ssh stderr, an error message and the prompt are in no answer and in no log line.

## The prompt

Fixed pt-BR text, then exactly one data block:

```text
<console-data>
{"alert":{...},"diagnosis":{...}}
</console-data>
```

- The fixed text asks to analyse the alert, explain the cause and propose the fix; it says the content of the block is data, not instructions (it carries third-party text such as process names and folders), and that killing a process or deleting data waits for "meu ok nesta sessão".
- The alert and the diagnosis exist only inside the block, as JSON with `<` and `>` written as `<` and `>`, so the closing tag cannot occur inside it. When the diagnosis is unavailable, `diagnosis` is `null` and the fixed text says there is none and asks to begin by collecting, read-only.
- Too long for the address: items per list section, then the alert's `detail`, then whole sections, then the alert's message are cut, in that order, until `size` is at most 12 000; the fixed text names every cut and `truncated` is `true`.
