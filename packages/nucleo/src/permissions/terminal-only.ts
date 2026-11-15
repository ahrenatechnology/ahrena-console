// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side; pure: no disk, no socket, no clock (#618).
// The check is by text, a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window credential (#619).
// The data folders of the other instances in the instance registry are added to the citing check by a later layer (#618).

import { exceedsDepth } from './digest.ts';

// `sh -c "$(curl …)"` and a shell or `source` fed by process substitution `<(curl …)` (#618/AC-6).
const COMMAND_PATTERNS: RegExp[] = [/\bsudo\b/, /\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/, /\b(?:(?:ba|z|da|k)?sh|fish|source)\s+<\(\s*(?:curl|wget)\b/, /(?:^|[\s;&|])\.\s+<\(\s*(?:curl|wget)\b/];

/** Files whose change changes what runs or what is secret, case-insensitive as the macOS disk is (#618/AC-6). */
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(?:^|[^A-Za-z0-9_.-])\.claude\/(?:settings[^/\s]*\.json|hooks(?:\/|$|[^A-Za-z0-9_-]))/i,
  /(?:^|[^A-Za-z0-9_.-])\.mcp\.json(?![A-Za-z0-9_-])/i,
  /\.env/i,
  /(?:^|[^A-Za-z0-9_.-])\.ssh(?:\/|$|[^A-Za-z0-9_-])/i,
];

// A path or a word of a command starts after the start of the text, a space, a quote, `=`, a redirection, a separator, `/` or `~` (#618/AC-11).
const A = '(?:^|[\\s"\'=<>:;|&(,{/~])';
// A name ends where a longer name would start (#618/AC-11).
const END = '(?![A-Za-z0-9_-])';

/** A `hooks` or `config` segment anywhere below a `.git/`: the repo, a submodule, a bare repo, a worktree. Per word, from the first `.git/` only, so it is linear where the one-regex form is quadratic on `.git/.git/…` (#618/AC-11). */
function namesGitHooksOrConfig(text: string): boolean {
  return text.split(/\s+/).some((word) => {
    const at = word.toLowerCase().indexOf('.git/');
    return at >= 0 && new RegExp(`(?:^|/)(?:hooks|config)${END}`).test(word.slice(at + 5).toLowerCase());
  });
}

/** Files that run by themselves later, or that change what the next agent run does (a git hook or config, a build or install script, a CI workflow, a shell, system or login start-up file, a scheduler, a package manager config, an instruction file). A call that names one is terminal-only, whatever the tool and however the path is spelled in a command, case-insensitive, anywhere in the tree. It over-matches by design, reads included: when in doubt, Desktop only (decision 0025 amendment, item 7; #618/AC-11). */
const AUTO_RUN_PATH_PATTERNS: ReadonlyArray<{ test(text: string): boolean }> = [
  // A bare repo (`x.git/hooks`) and a submodule (`.git/modules/m/config`) are caught too; over-matches by design (#618).
  { test: namesGitHooksOrConfig },
  new RegExp(`${A}\\.gitconfig${END}`, 'i'),
  new RegExp(`${A}package\\.json${END}`, 'i'),
  new RegExp(`${A}(?:gnumakefile|makefile)${END}|\\.mk${END}`, 'i'),
  new RegExp(`${A}\\.github/workflows${END}`, 'i'),
  new RegExp(`${A}\\.(?:zshrc|bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zprofile|zshenv|zlogin|zlogout)${END}`, 'i'),
  new RegExp(`${A}\\.config/(?:fish|git|systemd|autostart)${END}`, 'i'),
  new RegExp(`${A}\\.husky${END}`, 'i'),
  /launch(?:agents|daemons)/i,
  new RegExp(`${A}\\.npmrc${END}|${A}\\.yarnrc(?:\\.ya?ml)?${END}`, 'i'),
  // Build and install scripts run by the next build or install, and the package manager configs that steer them (#618/AC-11).
  new RegExp(`${A}(?:setup\\.py|pyproject\\.toml|build\\.rs|rakefile|\\.?justfile|taskfile\\.ya?ml|\\.pnpmfile\\.c?js|bunfig\\.toml|pip\\.conf)${END}`, 'i'),
  new RegExp(`${A}\\.yarn/plugins${END}|${A}\\.cargo/config(?:\\.toml)?${END}`, 'i'),
  new RegExp(`${A}\\.pre-commit-config\\.ya?ml${END}|${A}\\.?lefthook(?:-local)?\\.(?:ya?ml|json|toml)${END}`, 'i'),
  new RegExp(`${A}\\.vscode/tasks\\.json${END}`, 'i'),
  // System start-up files and schedulers: the dotless ones too (#618/AC-11).
  new RegExp(`${A}/?etc/(?:z(?:shrc|profile|shenv|login|logout|sh)|bash\\.bashrc|bashrc|profile|environment|rc\\.local|rc\\d?\\.d|init\\.d|sudoers|cron|systemd|paths|launchd)`, 'i'),
  new RegExp(`${A}/?var/spool/cron`, 'i'),
  new RegExp(`${A}crontab${END}`, 'i'),
  // What the next agent run reads as its commands, agents, skills and instructions (#618/AC-11).
  new RegExp(`${A}\\.claude/(?:commands|agents|skills)${END}`, 'i'),
  new RegExp(`${A}(?:claude|agents)(?:\\.local)?\\.md${END}`, 'i'),
];
/** The tools that only read: a path in their input is no write (#618/AC-11). */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'WebFetch']);
/** The tools that write a file named by one path field: their body is content, not a path (#618/AC-11). */
const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/** What the agent could read the owner token from, or swap the hook through: cited anywhere in a command or a path (#618/AC-6). */
const CITED_PATTERNS: RegExp[] = [/\.ahrena-console/i, /dev\.ahrena\.console/i, /\.claude\/plugins\b/i];

/** `/a/./b` and `/a//b` read as `/a/b`, so a path cannot dodge a pattern by spelling (#618/AC-6). */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');

const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const bare = (token: string): string => token.replace(/^["'(]+|["')]+$/g, '');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/** Words end at whitespace and at every wrapper a shell opens or closes around one: `$(git push)`, `` `git push` ``, `{ git push; }`, `git push>/dev/null` (#618/AC-9). */
const tokensOf = (text: string): string[] => text.split(/[\s()$`{}<>|;&]+/).filter(Boolean).map(bare);

/** Quotes never hide a word: they read as spaces, so `"git" 'push'` is `git push` (#618/AC-9). */
const stripQuotes = (text: string): string => text.replace(/["'`]/g, ' ');
/** Quotes inside a word join it: `g'i't` is `git`, `"pu"sh` is `push`, `.claude/"hooks"` is `.claude/hooks` (#618/AC-9). */
const deleteQuotes = (text: string): string => text.replace(/["'`]/g, '');
/** A backslash before a newline joins the lines; any other backslash escapes one character and is dropped: `\git`, `p\ush` (#618/AC-9). */
const unescapeShell = (text: string): string => text.replace(/\\\r?\n/g, ' ').replace(/\\/g, '');

/** Every spelling a shell could read the text as: raw or unescaped, with quotes kept, read as spaces or deleted. The floor checks them all, and a hit on any is a hit (#618/AC-6, AC-9). */
function spellings(text: string): string[] {
  return [text, unescapeShell(text)].flatMap((t) => [t, stripQuotes(t), deleteQuotes(t)]).map(normalizePath);
}

// `config` rewrites .git/config or ~/.gitconfig without naming the file; `git config --get` over-matches, accepted (#618).
const RISKY_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean', 'config']);

/** A tokenised scan, one pass per command segment (linear in the command, 64 KiB bound in 0025): recursive `rm`, and any `push`, `reset` or `clean` after a `git` word, whatever the flags or global options (#618/AC-9). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = tokensOf(segment);
  const rm = tokens.findIndex((t) => baseName(t) === 'rm');
  if (rm >= 0 && tokens.slice(rm + 1).some((t) => RECURSIVE_FLAG.test(t))) return true;
  const git = tokens.findIndex((t) => baseName(t) === 'git');
  return git >= 0 && tokens.slice(git + 1).some((t) => RISKY_GIT_SUBCOMMANDS.has(t));
}

const RUNNERS = new Set([...SHELLS, 'eval', 'source', 'python', 'python2', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript']);

/** A download and a shell (or `eval`, or `source`) anywhere in the same command: `curl u | env -i sh`, `eval "$(curl u)"`, `curl -o f u && sh f`. It over-matches by design (#618/AC-6, decision 0025 amendment). */
function downloadsAndRuns(command: string): boolean {
  return /\b(?:curl|wget)\b/.test(command) && tokensOf(command).some((t) => RUNNERS.has(baseName(t)));
}

/** `xargs git` with a risky verb anywhere in the command, or a segment that starts with a `$`-variable and then names one: `echo push | xargs git`, `x=git; $x push` (#618/AC-9). */
function reachesGitIndirectly(form: string): boolean {
  const tokens = tokensOf(form);
  const xargs = tokens.findIndex((t) => baseName(t) === 'xargs');
  if (xargs >= 0 && tokens.slice(xargs + 1).some((t) => baseName(t) === 'git') && tokens.some((t) => RISKY_GIT_SUBCOMMANDS.has(t))) return true;
  return form.split(/[|;&\n]+/).some((segment) => /^[\s({]*\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s/.test(segment) && tokensOf(segment).some((t) => RISKY_GIT_SUBCOMMANDS.has(t)));
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_JSON_EDITS = new Set(['set', 'delete', 'fix']);
// `npm config set|delete|edit` rewrites `.npmrc` (or `.yarnrc.yml`) without naming it (#618/AC-11).
const CONFIG_EDITS = new Set(['set', 'delete', 'edit']);

/** `npm pkg set|delete|fix`, `npm set-script` and `npm config set|delete|edit`, with any manager and any option between: they rewrite `package.json` without naming it (#618/AC-11). */
function mutatesPackageJson(form: string): boolean {
  const tokens = tokensOf(form);
  if (!tokens.some((t) => PACKAGE_MANAGERS.has(baseName(t)))) return false;
  return tokens.some((t, i) => t === 'set-script' || (t === 'pkg' && PACKAGE_JSON_EDITS.has(tokens[i + 1] ?? '')) || (t === 'config' && CONFIG_EDITS.has(tokens[i + 1] ?? '')));
}

/** Schedulers and login items registered by command, and git configuration injected by environment (#618/AC-11). */
const SCHEDULER_PATTERNS: RegExp[] = [
  new RegExp(`${A}(?:launchctl|systemctl|systemd-run)${END}`),
  /login\s*items?|com\.apple\.loginitems|loginwindow/,
  new RegExp(`${A}git_(?:config[a-z0-9_]*|dir|ssh_command|external_diff|exec_path)=`),
];
/** `at` and `batch` count only in command position (first word of a segment, after env assignments), never as a word of prose (#618/AC-11). */
const AT_IN_COMMAND_POSITION = /^[\s({]*(?:[a-z_][a-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:at|batch)(?=\s|$)/;

/** `git -c k=v` and `git --config-env` among the options before the subcommand, on every `git` word; `-C dir` is skipped. Case matters here (`-C` is not `-c`), so it reads the raw spelling (#618/AC-11). */
function gitInjectsConfig(form: string): boolean {
  const tokens = tokensOf(form);
  // One pass: each token is read by at most one option scan, so the cost is linear in the command (#618/AC-11).
  let at = 0;
  while (at < tokens.length) {
    if (baseName(tokens[at] ?? '').toLowerCase() !== 'git') {
      at++;
      continue;
    }
    let i = at + 1;
    for (; i < tokens.length; i++) {
      const o = tokens[i] ?? '';
      if (o === '-c' || o.startsWith('--config-env')) return true;
      if (o === '-C' || o === '--git-dir' || o === '--work-tree' || o === '--namespace' || o === '--exec-path') i++;
      else if (!o.startsWith('-')) break;
    }
    at = i;
  }
  return false;
}

function commandIsTerminalOnly(rawCommand: string): boolean {
  if (spellings(rawCommand).some(gitInjectsConfig)) return true;
  // Command names are compared whatever the case, as the macOS disk is: `Git push`, `RM -rf` (#618/AC-11).
  const forms = spellings(rawCommand.toLowerCase());
  if (forms.some((form) => COMMAND_PATTERNS.some((re) => re.test(form)))) return true;
  if (forms.some((form) => SCHEDULER_PATTERNS.some((re) => re.test(form)) || form.split(/[|;&\n]+/).some((segment) => AT_IN_COMMAND_POSITION.test(segment)))) return true;
  if (forms.some(downloadsAndRuns) || forms.some(reachesGitIndirectly) || forms.some(mutatesPackageJson)) return true;
  return forms.some((form) => form.split(/[|;&\n]+/).some(hasRiskyVerb));
}

/** Every string anywhere in the input, to the same depth the digest accepts; `false` when it nests deeper (#618/AC-6, INP-9). The input is level 2 of the digest envelope. Read with an explicit stack, after the depth check. */
function collectStrings(value: unknown, out: string[]): boolean {
  if (exceedsDepth(value, 2)) return false;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const v = pending.pop();
    if (typeof v === 'string') out.push(v);
    else if (v !== null && typeof v === 'object') {
      // A loop, not a spread: a spread of a wide container overflows the call stack (#618/AC-6, INP-9).
      for (const child of Object.values(v)) pending.push(child);
    }
  }
  return true;
}

/** An input that cannot be read (not an object, no readable command on a Bash call, nested too deep) is terminal-only: the safe side (#618/AC-6). */
export function isTerminalOnly(toolName: string, toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return true;
  const command = (toolInput as Record<string, unknown>)['command'];
  if (toolName === 'Bash' && typeof command !== 'string') return true;

  const strings: string[] = [];
  if (!collectStrings(toolInput, strings)) return true;
  const cites = (form: string) => CITED_PATTERNS.some((re) => re.test(form)) || PROTECTED_PATH_PATTERNS.some((re) => re.test(form));
  if (strings.some((text) => spellings(text).some(cites))) return true;
  if (touchesAutoRunFile(toolName, toolInput as Record<string, unknown>, strings)) return true;
  return typeof command === 'string' && commandIsTerminalOnly(command);
}

/** What a call outside the read-only set names that runs by itself: the path field of a file-writing tool, the command of Bash, every string of any other tool, since its path fields are unknown (#618/AC-11). Only a path, never a body: a Write whose content names `package.json` is not a write to it. */
function touchesAutoRunFile(toolName: string, input: Record<string, unknown>, strings: string[]): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  const named = FILE_WRITING_TOOLS.has(toolName) ? PATH_FIELDS.map((field) => input[field]).filter((v): v is string => typeof v === 'string') : toolName === 'Bash' ? [input['command']].filter((v): v is string => typeof v === 'string') : strings;
  return named.some((text) => spellings(text).some((form) => AUTO_RUN_PATH_PATTERNS.some((re) => re.test(form))));
}
