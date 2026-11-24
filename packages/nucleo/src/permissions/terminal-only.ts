// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side; pure: no disk, no socket, no clock (#618).
// The check is by text, a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window credential (#619).
// The floor over-matches in doubt, and #654 widened it: any command substitution, any unquoted glob, any `xargs`, `patch`, `unzip` and bulk copy is terminal-only (decision 0025 amendment, "when in doubt, Desktop only").
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
  new RegExp(`${A}\\.(?:zshrc|bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zprofile|zshenv|zlogin|zlogout|cshrc|tcshrc|kshrc|mkshrc|login|logout)${END}`, 'i'),
  new RegExp(`${A}\\.config/(?:fish|git|systemd|autostart)${END}`, 'i'),
  new RegExp(`${A}\\.husky${END}`, 'i'),
  // Cloud, cluster, container and GitHub CLI configs, and the terminal multiplexer start-up (#618/AC-11).
  new RegExp(`${A}\\.(?:aws|kube)/config${END}|${A}\\.docker/config\\.json${END}|${A}\\.config/gh${END}|${A}\\.tmux\\.conf${END}`, 'i'),
  /launch(?:agents|daemons)/i,
  new RegExp(`${A}\\.npmrc${END}|${A}\\.yarnrc(?:\\.ya?ml)?${END}`, 'i'),
  // Build and install scripts run by the next build or install, and the package manager configs that steer them (#618/AC-11).
  new RegExp(`${A}(?:setup\\.py|pyproject\\.toml|build\\.rs|rakefile|\\.?justfile|taskfile\\.ya?ml|\\.pnpmfile\\.c?js|bunfig\\.toml|pip\\.conf)${END}`, 'i'),
  new RegExp(`${A}\\.yarn/plugins${END}|${A}\\.cargo/config(?:\\.toml)?${END}`, 'i'),
  new RegExp(`${A}\\.pre-commit-config\\.ya?ml${END}|${A}\\.?lefthook(?:-local)?\\.(?:ya?ml|json|toml)${END}`, 'i'),
  new RegExp(`${A}\\.vscode/tasks\\.json${END}`, 'i'),
  // Python start-up files run by every interpreter or pytest start (#618/AC-11).
  new RegExp(`${A}(?:sitecustomize\\.py|usercustomize\\.py|conftest\\.py)${END}|\\.pth${END}`, 'i'),
  // System start-up files and schedulers: the dotless ones too (#618/AC-11).
  new RegExp(`${A}/?etc/(?:z(?:shrc|profile|shenv|login|logout|sh)|bash\\.bashrc|bashrc|profile|environment|rc\\.local|rc\\d?\\.d|init\\.d|sudoers|cron|systemd|paths|launchd)`, 'i'),
  new RegExp(`${A}/?var/spool/cron`, 'i'),
  new RegExp(`${A}crontab${END}`, 'i'),
  // What the next agent run reads as its commands, agents, skills and instructions (#618/AC-11).
  new RegExp(`${A}\\.claude/(?:commands|agents|skills|rules|output-styles)${END}`, 'i'),
  new RegExp(`${A}\\.claude\\.json${END}`, 'i'),
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

/** A cluster of short options (`-rf`): one dash, then letters only. Two linear scans, where `-[a-z]*r[a-z]*` under anchors backtracks quadratically on one long token (#654). */
const isShortCluster = (t: string): boolean => /^-[a-zA-Z]+$/.test(t);
const RECURSIVE_FLAG_LETTER = /[rR]/;
/** A long option spelled whole or abbreviated, with or without `=value`: git, tar and cp accept a unique prefix. The prefix needs `minLetters` after the dashes, so `--sou` is `--source` and `--s` is not. Linear: one `indexOf`, one `startsWith` (#654/AC-11). */
const isLongOption = (t: string, full: string, minLetters = 3): boolean => {
  if (!t.startsWith('--')) return false;
  const eq = t.indexOf('=');
  const name = eq < 0 ? t : t.slice(0, eq);
  return name.length >= 2 + minLetters && full.startsWith(name);
};
const isRecursiveFlag = (t: string): boolean => isLongOption(t, '--recursive') || (isShortCluster(t) && RECURSIVE_FLAG_LETTER.test(t));
/** Trims leading `"'(` and trailing `"')` with two indexes and one slice: linear, where the regex alternation is quadratic on a run of quotes after a letter (INP-9, #654). */
const bare = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && (token[start] === '"' || token[start] === "'" || token[start] === '(')) start++;
  while (end > start && (token[end - 1] === '"' || token[end - 1] === "'" || token[end - 1] === ')')) end--;
  return token.slice(start, end);
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);
/** Homebrew installs GNU tools under a `g` prefix (`gxargs`, `gfind`, `gcp`, `grm`, `gtar`): they read as the tool without it (#654/AC-9, AC-10, AC-11). */
const GNU_PREFIXED = new Set(['grm', 'gcp', 'gfind', 'gxargs', 'gtar']);
const toolName = (token: string): string => {
  const name = baseName(token);
  return GNU_PREFIXED.has(name) ? name.slice(1) : name;
};

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
// `send-pack` pushes and `update-ref` moves a branch without the verbs above (#654).
const RISKY_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean', 'config', 'send-pack', 'update-ref']);

const isRecursiveOrArchiveFlag = (t: string): boolean => isLongOption(t, '--recursive') || isLongOption(t, '--archive') || (isShortCluster(t) && /[rRa]/.test(t));
const FIND_RUNNING_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls']);
/** Git subcommands whose second word registers or starts something that runs later: `remote add`, `lfs install`, `maintenance start` (#654/AC-9). */
const GIT_SECOND_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['remote', new Set(['add', 'set-url', 'rename'])],
  ['submodule', new Set(['add'])],
  ['lfs', new Set(['install'])],
  ['maintenance', new Set(['start'])],
  // Bulk working-tree changes and lost work: `stash pop|apply` bring files back, `stash drop|clear` discard them (#654/AC-11, item 14).
  ['stash', new Set(['pop', 'apply', 'drop', 'clear'])],
]);
/** Verbs that rewrite many files or fetch and merge in one step: any word after `git` that is one counts (#654/AC-11). */
const GIT_BULK_VERBS = new Set(['apply', 'am', 'switch', 'pull', 'merge', 'rebase', 'cherry-pick', 'read-tree', 'checkout-index']);
/** A word that names a remote by address: `https://…` (read as `https:/…`, as the path spelling collapses `//`), `git@host:path`. Over-matches an `@` and a `:` anywhere (#654/AC-11). */
const isRemoteAddress = (t: string): boolean => t.includes(':/') || (t.includes('@') && t.includes(':'));

/** `git apply`, `am`, `switch`, `pull`, `merge`, `rebase`, `cherry-pick`, `read-tree` and `checkout-index` write files in bulk; `FETCH_HEAD` and a URL given to `fetch` bring a tree from outside; `remote add|set-url|rename`, `submodule add`, `lfs install`, `maintenance start` and `stash pop|apply|drop|clear` register a remote, hooks or a scheduler, or move work; `branch -d|-D|-f|-m|-M|-c|-C|--delete|--force|--move|--copy` deletes, moves, copies or overwrites a branch. Over-matches `git log apply`, by design (#654/AC-9, AC-11, items 1, 7, 14). */
function gitRegistersOrApplies(afterGit: string[]): boolean {
  const heads = new Set<string>();
  let fetch = false;
  let branch = false;
  for (const t of afterGit) {
    if (GIT_BULK_VERBS.has(t) || t === 'fetch_head') return true;
    if (fetch && isRemoteAddress(t)) return true;
    if (branch && (isLongOption(t, '--delete') || isLongOption(t, '--force') || (isShortCluster(t) && /[dfmc]/.test(t)) || isLongOption(t, '--move') || isLongOption(t, '--copy'))) return true;
    for (const head of heads) if (GIT_SECOND_WORDS.get(head)?.has(t)) return true;
    if (GIT_SECOND_WORDS.has(t)) heads.add(t);
    if (t === 'fetch') fetch = true;
    if (t === 'branch') branch = true;
  }
  return false;
}

/** A git pathspec that names many files or none: `.`, `./`, magic that starts with `:`, or a glob git expands itself, quoted or not (#654/AC-11). */
const isBulkPathspec = (t: string): boolean => t === '.' || t === './' || t.startsWith(':') || /[*?[]/.test(t);

/** A short-option token (one dash, not `--`) that holds `s`: `-s`, `-sHEAD~1`, `-Ws`, and `-S` once lowercased. Any `s` in a cluster may be `--source`, so it over-matches `restore -S` (#654/AC-11). Linear: two index reads and one `includes`. */
const holdsSourceOption = (t: string): boolean => t.length > 1 && t[0] === '-' && t[1] !== '-' && t.includes('s');
/** Options of `git checkout` that take the next word as their value, which is then no tree-ish or path (#654/AC-11). */
const CHECKOUT_OPTIONS_WITH_VALUE = new Set(['-b', '-B', '--orphan']);

/** `git checkout` and `git restore` that bring files without naming them: a bulk pathspec, `--pathspec-from-file`, `--source`, any short option holding `s` (`-s`, `-sHEAD~1`, `-Ws`), on `checkout` `-p` or `--patch` (any short cluster holding `p`, owner's decision), `FETCH_HEAD`, a tree-ish before `--` (`git checkout origin/main -- src`), or after `checkout` a second word that is no option value (`git checkout origin/main src`). Over-matches `git checkout -b x -- y` (the value of `-b` counts as a name before `--`), `git restore -S x` and `git checkout a b` where both are paths, by design (#654/AC-11, decision 0025 amendment). */
function gitBringsFilesInBulk(afterGit: string[]): boolean {
  let verb = '';
  let namedBeforeSeparator = false;
  let words = 0;
  let separated = false;
  let skipValue = false;
  for (const t of afterGit) {
    if (verb === '') {
      if (t === 'checkout' || t === 'restore') verb = t;
      continue;
    }
    if (isBulkPathspec(t) || holdsSourceOption(t) || isLongOption(t, '--source') || isLongOption(t, '--pathspec-from-file', 11) || t === 'fetch_head') return true;
    if (verb === 'checkout' && (isLongOption(t, '--patch') || isLongOption(t, '--force') || (isShortCluster(t) && /[pf]/.test(t)))) return true;
    if (t === '--') {
      if (namedBeforeSeparator) return true;
      separated = true;
    } else if (!t.startsWith('-')) {
      namedBeforeSeparator = true;
      if (skipValue) skipValue = false;
      else if (!separated && ++words >= 2 && verb === 'checkout') return true;
    } else if (!separated && CHECKOUT_OPTIONS_WITH_VALUE.has(t)) skipValue = true;
  }
  return false;
}

const TAR_NAMES = ['tar', 'bsdtar', 'gtar'];
/** `tar`, `bsdtar` or `gtar` in extract mode: `x` in the old-style cluster right after `tar`, `-x…`, `--extract` or `--get` (#654/AC-11). */
function tarExtracts(afterTar: string[]): boolean {
  const first = afterTar[0] ?? '';
  if (!first.startsWith('-') && first.includes('x')) return true;
  return afterTar.some((t) => (isShortCluster(t) && t.includes('x')) || isLongOption(t, '--extract') || t === '--get');
}

/** Tools that run other commands or unpack archives whatever their arguments: `xargs` and `parallel` run what they are given, the rest write many files (#654/AC-9, AC-11, items 6 and 15). */
const BULK_TOOLS: ReadonlySet<string> = new Set(['xargs', 'parallel', 'patch', 'unzip', 'ditto', 'pax', 'cpio', '7z', '7za', '7zz', 'jar', 'unar', 'xar', 'ar']);

/** Verbs that run other commands or bring files in bulk, found by base name: `find -exec|-delete|-fprint*`, any `xargs`, `patch`, `unzip`, `ditto`, recursive `cp` and `rsync`, extracting `tar`. Over-matches `npm version patch`, by design (#654/AC-9, AC-10, AC-11). */
function runsOrBringsInBulk(tokens: string[]): boolean {
  const names = tokens.map(toolName);
  if (names.some((n) => BULK_TOOLS.has(n))) return true;
  const after = (name: string): string[] | undefined => {
    const at = names.indexOf(name);
    return at >= 0 ? tokens.slice(at + 1) : undefined;
  };
  if (after('find')?.some((t) => FIND_RUNNING_FLAGS.has(t) || t.startsWith('-fprint'))) return true;
  if (after('cp')?.some(isRecursiveOrArchiveFlag) || after('rsync')?.some(isRecursiveOrArchiveFlag)) return true;
  if (after('scp')?.some(isRecursiveFlag) || after('sftp')?.some(isRecursiveFlag)) return true;
  if (after('rsync')?.some((t) => isLongOption(t, '--files-from', 5))) return true;
  if (after('wget')?.some((t) => isLongOption(t, '--recursive') || isLongOption(t, '--mirror') || (isShortCluster(t) && /[rm]/.test(t)))) return true;
  if (after('fd')?.some((t) => t.startsWith('--exec') || (isShortCluster(t) && t.includes('x')))) return true;
  if (after('rg')?.some((t) => t.startsWith('--pre'))) return true;
  const tar = TAR_NAMES.map(after).find((rest) => rest !== undefined);
  return tar !== undefined && tarExtracts(tar);
}

/** A shell given a command string: `sh -c`, `bash -lc`, `zsh -ec`. One pass: the first shell word arms the check, any later short cluster holding `c`, or a `--command` (abbreviated too), fires it (#654/AC-1, AC-4, item 2). */
function runsShellString(tokens: string[]): boolean {
  let shell = false;
  for (const t of tokens) {
    if (shell && ((isShortCluster(t) && t.includes('c')) || isLongOption(t, '--command'))) return true;
    if (SHELLS.has(baseName(t))) shell = true;
  }
  return false;
}

/** An interpreter and the option that takes its program from the command line, found by base name and checked on every later word of the segment (the case is lowered, so `-E` is `-e`). Over-matches every `node -e` from the Console, accepted (#654, item 9). */
const INLINE_CODE_FLAGS: ReadonlyArray<[(name: string) => boolean, (t: string) => boolean]> = [
  [(n) => /^python[0-9.]*$/.test(n), (t) => t === '-' || (isShortCluster(t) && t.includes('c'))],
  [(n) => n === 'node', (t) => isLongOption(t, '--eval') || isLongOption(t, '--print') || (isShortCluster(t) && /[ep]/.test(t))],
  [(n) => n === 'perl' || n === 'ruby' || n === 'osascript', (t) => isShortCluster(t) && t.includes('e')],
  [(n) => n === 'php', (t) => isShortCluster(t) && t.includes('r')],
];
/** One pass; each token is tested against the interpreters seen so far, at most four (#654, item 9). */
function runsInlineCode(tokens: string[]): boolean {
  const seen = new Set<number>();
  for (const t of tokens) {
    for (const i of seen) if (INLINE_CODE_FLAGS[i]?.[1](t)) return true;
    const name = baseName(t);
    INLINE_CODE_FLAGS.forEach(([isInterpreter], i) => {
      if (isInterpreter(name)) seen.add(i);
    });
  }
  return false;
}
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
/** An awk word anywhere in the command, and `system`, `|`, `getline` or `>` anywhere in the raw command, not only in awk's segment: the program text splits at its own `|` and `;`, and `system ("x")` has a space. Over-matches `awk … | sort`, by design (#654/AC-1, item 2). Linear: one token pass, four `includes`. */
function runsAwkProgram(form: string): boolean {
  if (!tokensOf(form).some((t) => AWKS.has(baseName(t)))) return false;
  return form.includes('system') || form.includes('|') || form.includes('getline') || form.includes('>');
}

/** A tokenised scan, one pass per command segment (linear in the command, 64 KiB bound in 0025): recursive `rm`, any `push`, `reset` or `clean` after a `git` word, whatever the flags or global options (#618/AC-9), and the verbs of #654 (AC-9, AC-10, AC-11). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = tokensOf(segment);
  const rm = tokens.findIndex((t) => toolName(t) === 'rm');
  if (rm >= 0 && tokens.slice(rm + 1).some(isRecursiveFlag)) return true;
  if (runsOrBringsInBulk(tokens) || runsShellString(tokens) || runsInlineCode(tokens)) return true;
  const git = tokens.findIndex((t) => baseName(t) === 'git');
  if (git < 0) return false;
  const afterGit = tokens.slice(git + 1);
  return afterGit.some((t) => RISKY_GIT_SUBCOMMANDS.has(t)) || gitRegistersOrApplies(afterGit) || gitBringsFilesInBulk(afterGit);
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

/** Words that open a package manager's own config command: `npm c set`, `npm conf delete`, `npm config edit` (#618/AC-11). */
const CONFIG_WORDS = new Set(['c', 'config', 'conf']);
/** Tools whose config command rewrites a file that runs or authenticates later: the word to find after the tool, anywhere in the segment (#618/AC-11). */
const TOOL_CONFIG_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['claude', new Set(['mcp', 'config', 'plugin', 'plugins'])],
  ['gh', new Set(['alias', 'config', 'auth', 'extension', 'extensions', 'ext'])],
  ['aws', new Set(['configure', 'update-kubeconfig'])],
  ['docker', new Set(['login', 'context'])],
  ['kubectl', new Set(['config'])],
  ['pip', new Set(['config'])],
  ['pip3', new Set(['config'])],
  ['podman', new Set(['login'])],
  ['gcloud', new Set(['auth', 'config'])],
]);

/** One pass over the tokens of a segment, each read once (linear): the manager or tool word, then a later word that edits its config, whatever options sit between (#618/AC-11). */
function segmentChangesToolConfig(tokens: string[]): boolean {
  let manager = false;
  let managerConfig = false;
  const seen = new Set<string>();
  for (const t of tokens) {
    if (manager && (t === 'login' || t === 'adduser')) return true;
    if (manager && (t === 'set' || (managerConfig && CONFIG_EDITS.has(t)))) return true;
    if (manager && CONFIG_WORDS.has(t)) managerConfig = true;
    for (const tool of seen) if (TOOL_CONFIG_WORDS.get(tool)?.has(t)) return true;
    // Any token named `claude` or `claude-code` is the tool, whoever runs it: `npx @anthropic-ai/claude-code plugin install` (#654/AC-7, item 8).
    const base = baseName(t);
    // A version after the package name is cut at its `@`, never at index 0 (a scope): `claude-code@latest` is `claude-code` (#654/AC-7, item 8).
    const at = base.indexOf('@', 1);
    const unversioned = at < 0 ? base : base.slice(0, at);
    const name = unversioned === 'claude-code' ? 'claude' : unversioned;
    if (PACKAGE_MANAGERS.has(name)) manager = true;
    else if (TOOL_CONFIG_WORDS.has(name)) seen.add(name);
  }
  return false;
}

/** `npm set` and `npm c set|delete|edit` (also pnpm, yarn, bun) write the user's `.npmrc`; `claude mcp|config|plugin` change what the next agent run loads; `gh alias|config|auth|extension` plant commands and credentials; `aws configure|update-kubeconfig`, `docker login|context`, `kubectl config` and `pip config` write credentials and endpoints (#654/AC-7). Within a segment, with any option between. Over-matches by design: reads included (#618/AC-11, decision 0025 amendment). */
function changesToolConfig(form: string): boolean {
  // `get-credentials` and `kubeconfig` write a cluster credential, whatever the tool (#654/AC-7).
  if (form.includes('get-credentials') || form.includes('kubeconfig')) return true;
  return form.split(/[|;&\n]+/).some((segment) => segmentChangesToolConfig(tokensOf(segment)));
}

/** Schedulers and login items registered by command, and git configuration or a chosen command injected by environment: `GIT_PAGER`, `GIT_EDITOR`, `GIT_ASKPASS`, `GIT_SSH`, `GIT_WORK_TREE`, `GIT_TEMPLATE_DIR` and the like (#618/AC-11, #654/AC-3, AC-8). */
const SCHEDULER_PATTERNS: RegExp[] = [
  new RegExp(`${A}(?:launchctl|systemctl|systemd-run)${END}`),
  /login\s*items?|com\.apple\.loginitems|loginwindow/,
  new RegExp(`${A}git_(?:config[a-z0-9_]*|dir|ssh_command|external_diff|exec_path|pager|editor|sequence_editor|askpass|ssh|proxy_command|work_tree|template_dir|common_dir|allow_protocol)\\+?=`),
  // What the shell or a tool reads from the environment to find its home, config, pager or editor, or to change directory unseen (#654, items 10 and 12).
  new RegExp(`${A}(?:oldpwd|home|cdpath|pwd|xdg_config_home|pager|editor|visual|ssh_askpass)\\+?=`),
];
/** `at` and `batch` count in command position (first word of a segment, after env assignments), and, once that word is a wrapper or a shell keyword, in any later word of the segment: a wrapper flag may take a separate value (`env -u FOO at now`), so the word cannot be told. Over-matches `env echo look at the logs`, by design; `echo look at the logs` stays false (#618/AC-11, #654/AC-1, decision 0025 amendment). */
const LEADING_NOISE = /^[\s({]+/;
const ENV_ASSIGNMENT = /^[a-z_][a-z0-9_]*=/;
const COMMAND_WRAPPERS = new Set(['env', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice', 'timeout', 'stdbuf', 'ionice', 'caffeinate', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'arch', 'script', 'gtimeout', 'doas', 'setsid', 'flock', 'watch', 'parallel', 'sandbox-exec', 'taskpolicy', 'case', 'function', 'builtin', 'noglob', 'nocorrect']);
/** `eval` and `source` run a string or a file the text cannot show, and a leading `.` is `source`: terminal-only in command position (#654/AC-1, AC-4, item 2). */
const SHELL_EVALUATORS = new Set(['eval', 'source']);
/** A new command position opens at a separator, after `$(` and after a backtick (#654/AC-1). */
const COMMAND_POSITION_SPLIT = /[|;&\n]+|\$\(|`/;
const isScheduler = (word: string): boolean => baseName(word) === 'at' || baseName(word) === 'batch';
/** Linear: strip the leading noise once, then one pass over the words: skip `name=value`, then the first remaining word is the command; a wrapper or keyword makes every later word count (#618/INP-9). */
function startsWithAt(segment: string): boolean {
  const words = segment.replace(LEADING_NOISE, '').split(/\s+/).filter(Boolean);
  const first = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
  if (first < 0) return false;
  const head = words[first] ?? '';
  const name = baseName(bare(head));
  if (name === 'popd' || changesDirectoryUnseen(words, first, name)) return true;
  if (SHELL_EVALUATORS.has(name) || head === '.') return true;
  // A function body or a `case` arm is a wrapper too: `f() { at now; }`, `f () {…}`, `x) at now` (#654/AC-1, item 2).
  const wrapper = COMMAND_WRAPPERS.has(baseName(head)) || head.endsWith(')') || words[first + 1] === '()';
  if (wrapper) return words.slice(first + 1).some((w) => isScheduler(w) || SHELL_EVALUATORS.has(baseName(w))) || words[first + 1] === '.';
  return isScheduler(head);
}

/** A program read from a pipe: a segment after a `|` whose command word, after wrappers, is a shell, `eval`, `source` or an inline-code interpreter (`echo x | python3`, `echo 'at now' | sh`). Over-matches `a || sh`, by design. One pass over the words of each segment (#654/AC-1, item 2). */
const isPipedProgramReader = (word: string): boolean => {
  const name = baseName(bare(word));
  return SHELLS.has(name) || SHELL_EVALUATORS.has(name) || INLINE_CODE_FLAGS.some(([isInterpreter]) => isInterpreter(name));
};
function readsProgramFromPipe(form: string): boolean {
  return form.split(/[;&\n]+/).some((command) =>
    command
      .split('|')
      .slice(1)
      .some((segment) => {
        const words = segment.replace(LEADING_NOISE, '').split(/\s+/).filter(Boolean);
        const first = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
        if (first < 0) return false;
        const head = words[first] ?? '';
        if (COMMAND_WRAPPERS.has(baseName(head))) return words.slice(first + 1).some(isPipedProgramReader);
        return isPipedProgramReader(head);
      }),
  );
}

/** `cd` or `pushd` with no target, with `-`, `~`, `~/` or `+N`, which go to `$HOME`, `$OLDPWD` or a stacked directory, so a later word may name a floor file in a directory the text does not show (#654, item 10). One scan over the flags after the verb, each read once. */
function changesDirectoryUnseen(words: string[], at: number, name: string): boolean {
  if (name !== 'cd' && name !== 'pushd') return false;
  let i = at + 1;
  while (i < words.length && (words[i] ?? '').startsWith('-') && words[i] !== '-') i++;
  const target = bare(words[i] ?? '');
  return target === '' || target === '-' || /^~\/*$/.test(target) || target.startsWith('+');
}

/** `~-`, `~+` and `~N` read as the previous, the current and the Nth stacked directory: a word that starts with one, split at the separators and `=` or `:` (#654, item 10). */
function namesTildeDirectory(text: string): boolean {
  return text.split(/[\s;|&()<>={}:"']+/).some((word) => /^~[-+0-9]/.test(word));
}

/** `env -S` and `env --split-string` split one string into a command the text does not show. Per segment, one pass, case matters (`-S`), so it reads the raw spelling (#654/AC-4, item 3). */
function envSplitsString(text: string): boolean {
  return text.split(/[|;&\n]+/).some((segment) => {
    let env = false;
    for (const t of tokensOf(segment)) {
      if (env && (/^-[A-Za-z]*S/.test(t) || isLongOption(t, '--split-string'))) return true;
      if (baseName(t) === 'env') env = true;
    }
    return false;
  });
}

/** The git global options that point git at another repository, work tree or program directory: terminal-only in both spellings, `=v` and a separate value (#654/AC-2). */
const GIT_REPOSITORY_OPTIONS = ['--git-dir', '--work-tree', '--exec-path'];
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--attr-source', '--super-prefix']);
/** The git global options that take no value. A long option before the subcommand that is in neither set nor spelled `--x=v` may take a separate value, so the subcommand cannot be told: terminal-only (#618/AC-9, decision 0025 amendment). */
const GIT_OPTIONS_WITHOUT_VALUE = new Set(['--version', '--help', '--html-path', '--man-path', '--info-path', '--paginate', '--no-pager', '--no-replace-objects', '--bare', '--no-optional-locks', '--no-lazy-fetch', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice']);
/** Subcommands where `-c` is no configuration: `commit -c <commit>` reuses a message, `log`, `diff` and `show` take it as combined diff (#618/AC-9). */
const GIT_SUBCOMMANDS_WITH_PLAIN_C = new Set(['commit', 'log', 'diff', 'show']);

/** A git option that injects configuration or a template, on any token after a `git` word of the segment, not only before the subcommand: `git clone -c k=v`, `git init --template=d`, `-ck=v`. Case matters (`-C` is not `-c`), so it reads the raw spelling. After the subcommand, `-c` is let through only for the subcommands that read it otherwise; any other subcommand, an alias included, over-matches (#618/AC-9, decision 0025 amendment). */
function gitSegmentInjectsConfig(tokens: string[]): boolean {
  // Every `git` word restarts the scan, so a second git nested in the segment (`$(git -c k=v status)`) is read with its own subcommand; one pass, each token read once (#618/AC-9).
  let active = false;
  let subcommand: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const o = tokens[i] ?? '';
    if (baseName(o).toLowerCase() === 'git') {
      active = true;
      subcommand = undefined;
      continue;
    }
    if (!active) continue;
    const plainC = o.startsWith('-c') && !o.startsWith('--');
    if (o.startsWith('--config') || o.startsWith('--template') || GIT_REPOSITORY_OPTIONS.some((opt) => o === opt || o.startsWith(`${opt}=`))) return true;
    if (plainC && (subcommand === undefined || !GIT_SUBCOMMANDS_WITH_PLAIN_C.has(subcommand))) return true;
    if (subcommand === undefined && o.startsWith('--') && !o.includes('=') && !GIT_OPTIONS_WITH_VALUE.has(o) && !GIT_OPTIONS_WITHOUT_VALUE.has(o)) return true;
    if (GIT_OPTIONS_WITH_VALUE.has(o) && subcommand === undefined) i++;
    else if (subcommand === undefined && !o.startsWith('-')) subcommand = o;
  }
  return false;
}

function gitInjectsConfig(form: string): boolean {
  // One pass per segment, each token read once: linear in the command (#618/AC-9).
  return form.split(/[|;&\n]+/).some((segment) => gitSegmentInjectsConfig(tokensOf(segment)));
}

/** Words of a command as the shell would split them, with each character marked quoted or not: quotes and backslashes are dropped, a quoted or escaped character reads as `q` in `masked`. Redirections and separators split words (#618/AC-11). */
function shellWords(command: string): Array<{ plain: string; masked: string }> {
  const words: Array<{ plain: string; masked: string }> = [];
  let plain = '';
  let masked = '';
  let quote = '';
  const flush = () => {
    if (plain) words.push({ plain, masked });
    plain = '';
    masked = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    if (quote) {
      if (c === quote) quote = '';
      else {
        plain += c;
        masked += 'q';
      }
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') {
      plain += command[++i] ?? '';
      masked += 'q';
    } else if (/[\s;|&()<>]/.test(c)) flush();
    else {
      plain += c;
      masked += c;
    }
  }
  flush();
  return words;
}

/** Linear scan: `*`, `?`, `[`, or a `{` closed by `}` with a `,` or `..` between (#618/INP-9). */
function hasUnquotedGlob(masked: string): boolean {
  let open = false;
  let sep = false;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '*' || c === '?' || c === '[') return true;
    if (c === '{') {
      open = true;
      sep = false;
    } else if (open && (c === ',' || (c === '.' && masked[i + 1] === '.'))) sep = true;
    else if (c === '}') {
      if (open && sep) return true;
      open = false;
      sep = false;
    }
  }
  return false;
}
/** An unquoted `*`, `?`, `[` or `{a,b}` in any word, whatever it starts with: it could expand to a floor path (`CLAUDE.m{d,x}`, `pack*.json`, `git pu{sh,x}`). Over-matches `ls src/*.ts` and a URL with `?`, by design (#654/AC-4, decision 0025 amendment). */
function expandsPathByGlob(command: string): boolean {
  const words = shellWords(command);
  if (words.some(({ masked }) => hasUnquotedGlob(masked))) return true;
  // A `$` in the command may expand a variable that holds a quoted glob (`p='CLAUDE.m?'; tee -a $p`): then a quoted `*`, `?` or `[` counts as unquoted (#654/AC-4, item 11).
  return command.includes('$') && words.some(({ plain }) => /[*?[]/.test(plain));
}

/** An auto-run folder named as any segment of a word (split at whitespace, separators and `=`), so `.claude/.`, `.claude/x/..`, `/w/.git/x` and `--dir=.git/hooks` match: the file comes in a later word (`cd .claude && tee settings.local.json`). Over-matches `ls ~/.config` and `ls etc`, by design (#618/AC-11, #654/AC-5, decision 0025 amendment). */
const AUTO_RUN_DIRECTORIES: ReadonlySet<string> = new Set(['.claude', '.git', '.github', '.aws', '.kube', '.docker', '.config', '.vscode', '.cargo', '.yarn', 'etc']);
function namesAutoRunDirectory(text: string): boolean {
  return text.split(/[\s;|&()<>=:,]+/).some((word) => word.toLowerCase().split('/').some((segment) => AUTO_RUN_DIRECTORIES.has(segment)));
}

const EXPANSION = /[$`]/;
/** The argument of `cd`, `pushd`, `-C`, `--git-dir` or `--work-tree` holding `$` or a backtick: the directory it moves to is unknown, so a later word could name a floor file in it. One pass, each token read once; case matters (`-C`), so it reads the raw spelling (#654/AC-5). */
function movesToExpandedDirectory(text: string): boolean {
  let expectArgument = false;
  let skipFlags = false;
  for (const t of text.split(/[\s;|&()<>{}]+/)) {
    if (expectArgument && !(skipFlags && t.startsWith('-'))) {
      if (EXPANSION.test(t)) return true;
      expectArgument = false;
    }
    const name = baseName(t);
    if (name === 'cd' || name === 'pushd') [expectArgument, skipFlags] = [true, true];
    else if (t === '-C' || t === '--git-dir' || t === '--work-tree') [expectArgument, skipFlags] = [true, false];
    else if (EXPANSION.test(t) && (t.startsWith('-C') || t.startsWith('--git-dir=') || t.startsWith('--work-tree='))) return true;
  }
  return false;
}

/** An expansion joined to a path: a word with `$` and `/`, or `$(…)` next to a `/`. The text it expands to is unknown, so it could rebuild a floor path (`d=.cla; tee ${d}ude/settings.local.json`). Over-matches `cat $HOME/x` (#618/AC-11, decision 0025 amendment). */
function joinsExpansionWithSlash(command: string): boolean {
  if (command.includes('$(') && (command.includes(')/') || command.includes('/$('))) return true;
  return shellWords(command).some(({ plain }) => plain.includes('$') && plain.includes('/'));
}

/** `print` with a flag that holds `P` (`-P`, `-rP`, `-r -P`) in any later word of its segment: zsh expands the prompt escapes of the text. One pass per segment, from the first `print` word (#654/AC-6). */
function printsWithPromptExpansion(command: string): boolean {
  return command.split(/[|;&\n]+/).some((segment) => {
    const tokens = tokensOf(segment);
    const print = tokens.findIndex((t) => baseName(t) === 'print');
    return print >= 0 && tokens.slice(print + 1).some((t) => /^-[A-Za-z]*P/.test(t));
  });
}

function commandIsTerminalOnly(rawCommand: string): boolean {
  // `$'\x2e…'` spells any character by code, so no text scan can read it: any ANSI-C quote is terminal-only (#618/AC-11).
  if (rawCommand.includes("$'")) return true;
  // Any command substitution (`$(…)` or a backtick) hides what runs, and a backslash before a digit, `x`, `u` or `U`, `print -P` and `%b` (with any width or flag) spell a character by code: all over-match by design (#654/AC-6, AC-11).
  if (rawCommand.includes('$(') || rawCommand.includes('`') || /\\[0-9xuU]/.test(rawCommand) || /%[-+ #0-9.*]*b/.test(rawCommand) || printsWithPromptExpansion(rawCommand)) return true;
  if (spellings(rawCommand).some((form) => gitInjectsConfig(form) || namesAutoRunDirectory(form) || movesToExpandedDirectory(form) || namesTildeDirectory(form) || envSplitsString(form)) || expandsPathByGlob(rawCommand) || joinsExpansionWithSlash(rawCommand)) return true;
  // Command names are compared whatever the case, as the macOS disk is: `Git push`, `RM -rf` (#618/AC-11).
  const forms = spellings(rawCommand.toLowerCase());
  if (forms.some((form) => COMMAND_PATTERNS.some((re) => re.test(form)))) return true;
  if (forms.some((form) => SCHEDULER_PATTERNS.some((re) => re.test(form)) || form.split(COMMAND_POSITION_SPLIT).some(startsWithAt))) return true;
  if (forms.some(downloadsAndRuns) || forms.some(reachesGitIndirectly) || forms.some(mutatesPackageJson) || forms.some(changesToolConfig) || forms.some(readsProgramFromPipe) || forms.some(runsAwkProgram)) return true;
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
