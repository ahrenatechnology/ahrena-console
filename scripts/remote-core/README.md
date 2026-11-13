# Updating the core of a remote machine

Issue 449, decision [0021](../../docs/decisoes/0021-remote-core-update.md) (the contract: read it before
changing a step or an exit code), extended by issue 462, decision
[0022](../../docs/decisoes/0022-remote-core-update-button.md) (the lock, exit 33, `--progress json`, the run from
stdin, the signals). `update-remote-core.mjs` is one ESM file that needs only Node 24 and git. A
person runs it on the machine that holds the checkout (the Workstation); the Mac never runs it and never
updates anything by itself.

## Update

```
node scripts/remote-core/update-remote-core.mjs --checkout <checkout> --ref app-v0.0.17 \
  --mac-telemetry-version 1 --mac-credential-command yes
```

The screen of the Console prints this command with the right values (the two `--mac-*` flags say what the
Mac supports; the guard needs them). `--ref` is always explicit: an `app-vX.Y.Z` tag, `origin/main` or a sha.

Steps, in order (nothing is stopped before step 4):

1. Preflight: tracked changes in the checkout stop it (exit 30, no `--force`), and so does a ref that does not
   resolve. `git fetch origin --tags` runs first (`--no-fetch` skips it).
2. Guard: reads `packages/nucleo/remote-contract.json` of the target with `git show` and refuses a target
   that would leave the machine without a connection (see the exit codes).
3. Finds the running core by its port (`GET /api/overview`) and checks it before any signal: with `/proc`,
   the cmdline has this checkout's `src/api/cli.ts` and `--port`, and the process belongs to the same uid;
   without `/proc`, pass `--core-options` and `ss -ltnp` must list the pid. The pid in the overview is only a
   hint, anyone on the port can forge it.
4. Backup of `nucleo.sqlite` with the online `backup()` of `node:sqlite` into
   `<data-dir>/backups/update-<UTC>-<old commit>/` (the last 5 are kept). Failure: exit 31, the core keeps running.
5. Stops: `systemctl --user stop ahrena-console-core.service` when the unit exists, otherwise `SIGTERM` to the
   verified pid (15 s, then `SIGKILL`).
6. `git checkout --detach <sha>` (no `npm install`: a target that adds production dependencies is refused
   before step 5), starts the core again with the same options and waits for `/api/overview` to answer the
   target commit and version. When the target requires the owner proof it also runs
   `core remote-credential` there and requires exit 0.
7. Any failure after the stop rolls back: the old commit (and branch), the database restored from the backup
   (`-wal` and `-shm` removed first) and the old core started again. Exit 40 if it is back, 41 if the rollback
   failed too (the message names the backup and the old commit; the backup is kept). The database is restored through a temporary file and a rename, and only when the new core was started; if it never started, the live database stays as it is.

Running it twice with the same `--ref` is a no-op (exit 0). `update.log` in the data folder records each run.

| Exit | Meaning |
|---|---|
| 0 | updated and confirmed (or `--check` passed, or already there) |
| 2 | usage |
| 20 | guard: the telemetry protocol of the target differs from the Mac's |
| 21 | guard: the target needs the owner proof and the Mac has no credential command |
| 22 | guard: the target has no manifest |
| 23 | guard: the Mac flags are missing |
| 30 | tracked changes, unknown ref, or the target adds production dependencies |
| 31 | the backup failed |
| 32 | the process does not check out (cmdline, port, uid), its options cannot be read, or it did not stop |
| 33 | another update holds `<data-dir>/update.lock`; nothing was touched |
| 40 | failed and rolled back |
| 41 | failed and the rollback failed |
| 130 | canceled by SIGINT, SIGTERM or SIGHUP during the check, before the backup; nothing was touched |

`--check` runs only the preflight and the guard and touches nothing. `--allow-disconnect` skips only 20 to 23
(it prints in capital letters that the machine may be left without a connection); the preflight, the backup,
the confirmation and the rollback still apply. `--core-options "--port 4720 --installation dev --data-dir <dir> --no-github"`
gives the options explicitly when `/proc` cannot be read; the options are never guessed.

## The lock (exit 33)

`<data-dir>/update.lock` is created with `O_EXCL` (`wx`), mode `0600`, with `{"pid": <n>, "startedAt": "<ISO>"}`,
before any git work, so it holds for two Macs, a window and a terminal at once. A live lock makes the script
exit 33 without touching anything. A lock is taken over, with a line in `update.log`, when its `pid` does not exist
(`kill(pid, 0)` fails with `ESRCH`) or its `startedAt` is more than 30 minutes old (content that cannot be read
counts as live until the file itself is 30 minutes old). It is removed at the end, on success or failure, and when
a signal cancels the run; only a lock still holding the script's own content is removed. `--check` never creates the
lock, but reads it: a live lock gives 33, a stale one is ignored and left alone. When the core's own data folder
differs from `--data-dir`/`--core-options`, the lock is taken there too.

## Progress for a program: `--progress json`

With `--progress json`, stdout carries only NDJSON (one object per line) and the human messages go to stderr.
Phases, in this order: `check` (preflight, guard, dependencies, process check), `backup`, `swap` (just before the
core is stopped: no clean way back from here), `start`, `verify`, and `rollback` (only after a failure past `swap`).
Exactly one `result` closes every run, whatever the exit code:

```
{"v":1,"event":"phase","phase":"check"}
{"v":1,"event":"result","exit":40,"reason":"started-failed","backup":"/…/backups/update-…/nucleo.sqlite","oldCommit":"<sha>","newCommit":"<sha>"}
```

The keys are exactly those, in that order; `backup`, `oldCommit`, `newCommit` are `null` until known. `reason` is
`null` except: for exit 30, `not-a-checkout`, `dirty-tree`, `unknown-ref`, `new-dependencies`; for exit 32,
`process-mismatch`, `no-options`, `data-dir-mismatch`; for 40 and 41, `started-failed`. The exit code of the
process, not the JSON, is the verdict.

## Run from stdin

The script is one file with no relative imports, so a program can send it over the connection instead of
having a copy there:

```
ssh <host> node --disable-warning=ExperimentalWarning --input-type=module - \
  --checkout <checkout> --ref app-v0.0.17 --mac-telemetry-version 1 --mac-credential-command yes --progress json \
  < scripts/remote-core/update-remote-core.mjs
```

`--checkout` gives the repository, since the script cannot find its own file. The hint printed after an orphan
start does not name a script path for the same reason.

Notes: the lock is first taken in `--data-dir` (or the data folder of `--core-options`, or `~/.ahrena-console`), and, when the running core's own data folder is another one, also there; a stale lock is moved aside under a unique name and judged again before it is deleted, so two scripts cannot both take it over. `reason: started-failed` covers every failure after the swap (stop, checkout, start or confirm), for both 40 and 41. A process killed between creating the lock and writing it leaves an empty file that counts as live for 30 minutes.

## Signals

Until the `backup` phase begins, SIGINT, SIGTERM and SIGHUP cancel: the lock is released, the result is
`exit 130` and nothing was touched (a signal that arrives while a git command runs is handled when it returns; the `git fetch` has a 120 s timeout).
From the `backup` phase on SIGHUP, SIGPIPE, SIGINT and SIGTERM are ignored and a closed stdout is tolerated, so
a dropped connection never leaves the machine half-updated: the script finishes alone, with success or rollback.
Only SIGKILL stops it, and then the dead `pid` makes the lock stale. `--check` keeps the cancel handlers for its
whole run.

## The systemd user unit

Run once, on the machine, so the core is supervised and comes back after a reboot instead of staying an orphan:

```
node scripts/remote-core/update-remote-core.mjs install-unit --checkout <checkout>
loginctl enable-linger "$(id -un)"
```

`install-unit` verifies the running core like step 3, writes
`~/.config/systemd/user/ahrena-console-core.service`, runs `systemctl --user daemon-reload` and
`systemctl --user enable ahrena-console-core.service` (a failure there leaves the running core alone), then stops the
orphan, runs `systemctl --user start ahrena-console-core.service` and checks the overview (if the unit does not come up,
the orphan is started again). With no running core, pass
`--core-options`. If linger is off it prints the `loginctl enable-linger "$(id -un)"` line and exits 0; it never
calls `sudo`. In an SSH session without a full login it sets `XDG_RUNTIME_DIR=/run/user/$(id -u)` when empty.

```
[Unit]
Description=Ahrena Console core
After=network.target

[Service]
Type=simple
WorkingDirectory=<checkout>/packages/nucleo
ExecStart=<node> --disable-warning=ExperimentalWarning <checkout>/packages/nucleo/src/api/cli.ts --port 4720 --installation dev --data-dir <home>/.ahrena-console --no-github
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
StandardOutput=append:<home>/.ahrena-console/core-stdout.log
StandardError=inherit

[Install]
WantedBy=default.target
```

With the unit in place, the update uses `systemctl --user stop` and `start`; it sends no signal itself.

## Manual step on the Workstation (not done by this pull request)

Nothing here runs on the real Workstation. Today it runs commit `81251bd` from a checkout, as an orphan
process, and that checkout has no script and the target has to be reached with `--allow-disconnect` or after
the owner proof (issue 388) is configured. The person does, once, by hand:

```
git -C <checkout> fetch origin --tags
git -C <checkout> show origin/main:scripts/remote-core/update-remote-core.mjs > ~/.ahrena-console/update-remote-core.mjs
node ~/.ahrena-console/update-remote-core.mjs --checkout <checkout> --ref origin/main --check \
  --mac-telemetry-version 1 --mac-credential-command yes
node ~/.ahrena-console/update-remote-core.mjs --checkout <checkout> --ref origin/main \
  --mac-telemetry-version 1 --mac-credential-command yes --allow-disconnect   # only if the guard asked for it and you accept it
node ~/.ahrena-console/update-remote-core.mjs install-unit --checkout <checkout>
loginctl enable-linger "$(id -un)"
```

Then reboot the Workstation and confirm the core came back by itself (criterion 3 only holds after that, and
it is checked by the person, not by the tests).
