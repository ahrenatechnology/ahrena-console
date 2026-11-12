# Updating the core of a remote machine

Issue 449, decision [0021](../../docs/decisoes/0021-remote-core-update.md) (the contract: read it before
changing a step or an exit code). `update-remote-core.mjs` is one ESM file that needs only Node 24 and git. A
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
| 40 | failed and rolled back |
| 41 | failed and the rollback failed |

`--check` runs only the preflight and the guard and touches nothing. `--allow-disconnect` skips only 20 to 23
(it prints in capital letters that the machine may be left without a connection); the preflight, the backup,
the confirmation and the rollback still apply. `--core-options "--port 4720 --installation dev --data-dir <dir> --no-github"`
gives the options explicitly when `/proc` cannot be read; the options are never guessed.

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
