#!/usr/bin/env node
// Shim: the desktop app runs `node packages/nucleo/src/dono/cli.ts subir --pai <pid> --json` until phase 4 of #173; it goes in phase 6.
import '../owner/cli.ts';
