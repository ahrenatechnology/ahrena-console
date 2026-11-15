# Voice of the on-screen text

The pt-BR text a person reads in the console follows the voice rules approved by the product
owner on 2026-11-14 (version 1), in [`voice-rules.json`](voice-rules.json): word and character limits
for labels, titles and support text; forbidden and preferred terms; and the patterns of AI filler
(phrases, exclamation marks, long dashes, emoji). The rules file also documents how a string is
classified as a label, title or support text, how words are matched, and which strings count as
on-screen text.

## The ratchet

The lint is [`test/voice-lint.lib.mjs`](../../test/voice-lint.lib.mjs), held by
[`test/voice-lint.test.mjs`](../../test/voice-lint.test.mjs). It reads the string literals of
`packages/nucleo/ui/*.js` and `packages/nucleo/ui/screens/*.js` and the text of
`packages/nucleo/ui/index.html`.

It holds new and changed code. What already broke the rules is frozen in
[`test/voice-lint.baseline.json`](../../test/voice-lint.baseline.json), keyed by file, rule and text
(no line numbers). The test fails on a finding that is not in the baseline, and on a baseline entry
that no longer occurs, so the baseline only shrinks.

- Fix the text; never add a baseline entry.
- The baseline only shrinks. The test refuses a stale entry, and `VOICE_LINT_SHRINK=1` refuses to write while a
  new violation exists. Nothing in the test stops a hand-added baseline entry: review of the diff of
  `test/voice-lint.baseline.json` catches it.
- When a fix removes a baselined violation, the test asks for it to leave the baseline:
  `VOICE_LINT_SHRINK=1 node --test --test-concurrency=1 test/voice-lint.test.mjs`.
- Changing a rule is a change to the rules file, approved by the product owner, with a new version.
