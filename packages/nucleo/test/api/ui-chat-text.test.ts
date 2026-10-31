// The Conversa text drawn like a chat (ui/screens/chat-text.js), in the minimal DOM: markdown for what a
// person or the assistant wrote, a card for what the harness wraps in tags, and nothing ever as HTML.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto, type NoFalso } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
const { markdown, inline, messageBody, pieces } = await import('../../ui/screens/chat-text.js');

/** Every element under the nodes, depth first. */
function all(nodes: NoFalso[]): ElementoFalso[] {
  const out: ElementoFalso[] = [];
  const walk = (n: NoFalso) => {
    if (!(n instanceof ElementoFalso)) return;
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
const tags = (nodes: NoFalso[], tag: string) => all(nodes).filter((e) => e.tagName === tag.toUpperCase());
const byClass = (nodes: NoFalso[], c: string) => all(nodes).filter((e) => e.classList.contains(c));
const text = (nodes: NoFalso[]) => nodes.map((n) => (typeof n === 'string' ? n : texto(n))).join('');

describe('links', () => {
  test('a bare https URL and a markdown link open in a new tab, with no opener', () => {
    const nodes = inline('veja https://github.com/ahrenatechnology/ahrena-console/pull/351. e [o PR](https://example.com/x)');
    const links = tags(nodes, 'a');
    assert.equal(links.length, 2);
    assert.equal(links[0]!.getAttribute('href'), 'https://github.com/ahrenatechnology/ahrena-console/pull/351', 'the trailing dot stays out');
    assert.equal(links[1]!.getAttribute('href'), 'https://example.com/x');
    for (const a of links) {
      assert.equal(a.getAttribute('target'), '_blank');
      assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    }
  });

  test('a file path or another scheme is not a link: its text in code, the target in the tooltip', () => {
    const nodes = inline('[session-detail.js:669](packages/nucleo/ui/screens/session-detail.js:669) [x](javascript:alert(1))');
    assert.equal(tags(nodes, 'a').length, 0);
    const codes = tags(nodes, 'code');
    assert.equal(texto(codes[0]!), 'session-detail.js:669');
    assert.equal(codes[0]!.getAttribute('title'), 'packages/nucleo/ui/screens/session-detail.js:669');
  });
});

describe('markdown blocks', () => {
  test('headings, a nested list, a table, a quote and a fenced code block', () => {
    const nodes = markdown('## Título\n\n1. **um**\n2. dois\n   - dentro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> nota\n\n```bash\nnpm test\n```');
    assert.equal(texto(tags(nodes, 'h4')[0]!), 'Título');
    assert.equal(tags(nodes, 'ol').length, 1);
    assert.equal(texto(tags(nodes, 'strong')[0]!), 'um');
    assert.equal(texto(tags(nodes, 'ul')[0]!), 'dentro', 'the indented item nests under the second');
    assert.deepEqual(tags(nodes, 'td').map(texto), ['1', '2']);
    assert.equal(texto(tags(nodes, 'blockquote')[0]!), 'nota');
    assert.equal(texto(tags(nodes, 'pre')[0]!), 'npm test');
    assert.equal(texto(byClass(nodes, 'sd-md-pre-head')[0]!), 'bash');
  });

  test('single newlines inside a paragraph become line breaks', () => {
    const nodes = markdown('linha um\nlinha dois');
    assert.equal(tags(nodes, 'p').length, 1);
    assert.equal(tags(nodes, 'br').length, 1);
  });

  test('HTML in the text stays text: no element comes from it', () => {
    const nodes = markdown('<img src=x onerror="alert(1)"> e <script>alert(1)</script>');
    assert.equal(tags(nodes, 'img').length + tags(nodes, 'script').length, 0);
    assert.match(text(nodes), /<img src=x/);
  });
});

describe('harness tags', () => {
  test('a task notification reads as a card: the state in the title, the summary beside it, the ids inside', () => {
    const { nodes, system } = messageBody('<task-notification>\n<task-id>bwbug79bw</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>npm test terminou</summary>\n</task-notification>');
    assert.equal(system, true);
    const head = byClass(nodes, 'sd-note-head')[0]!;
    assert.match(texto(head), /Tarefa em segundo plano concluída/);
    assert.match(texto(head), /npm test terminou/);
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    assert.notEqual(byClass(nodes, 'sd-note-body')[0]!.getAttribute('hidden'), null, 'the ids stay closed until the click');
    assert.deepEqual(tags(nodes, 'dd').map(texto), ['bwbug79bw', 'toolu_01', '/tmp/x.output']);
  });

  test('a notice opened stays open when a live redraw builds it again', () => {
    const src = '<system-reminder>\nLinked sessions now\n</system-reminder>';
    const head = byClass(messageBody(src).nodes, 'sd-note-head')[0]!;
    head.dispatchEvent({ type: 'click' });
    const again = messageBody(src).nodes;
    assert.equal(byClass(again, 'sd-note-head')[0]!.getAttribute('aria-expanded'), 'true');
    assert.equal(byClass(again, 'sd-note-body')[0]!.getAttribute('hidden'), null);
  });

  test('a notification cut before its closing tag still reads as its card', () => {
    const { nodes, system } = messageBody('<task-notification> <task-id>bwbug79bw</task-id> <tool-use-id>toolu_01</tool-use-id> <output-file>/tmp/claude-8540…');
    assert.equal(system, true);
    assert.match(texto(byClass(nodes, 'sd-note-head')[0]!), /Tarefa em segundo plano/);
    assert.doesNotMatch(text(nodes), /<task-id>/);
  });

  test('a system reminder is a quiet notice; a slash command and its output read as one command line', () => {
    assert.ok(byClass(messageBody('<system-reminder>\nLinked sessions now\n</system-reminder>').nodes, 'sd-note-quiet').length);
    const cmd = messageBody('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>foca no PR</command-args>');
    assert.equal(cmd.system, true);
    assert.equal(byClass(cmd.nodes, 'sd-cmd-row').length, 1);
    assert.match(texto(byClass(cmd.nodes, 'sd-cmd-chip')[0]!), /\/compact/);
    assert.equal(texto(byClass(cmd.nodes, 'sd-cmd-args')[0]!), 'foca no PR');
    assert.equal(texto(byClass(messageBody('<local-command-stdout>Compacted</local-command-stdout>').nodes, 'sd-cmd-out')[0]!), 'Compacted');
  });

  test('pasted text between the person\'s words keeps the words as the message and folds the paste', () => {
    const parts = pieces('Olha:\n<pasted_content id="1">\n# Valores\n- tier: enterprise\n</pasted_content>\nBate?');
    assert.deepEqual(parts.map((p: { tag?: string; text?: string }) => p.tag ?? p.text), ['Olha:', 'pasted_content', 'Bate?']);
    const { nodes, system } = messageBody('Olha:\n<pasted_content id="1">\n# Valores\n</pasted_content>');
    assert.equal(system, false);
    assert.match(texto(byClass(nodes, 'sd-note-head')[0]!), /Texto colado/);
  });

  test('a tag named after an Object.prototype key is text, not a lookup', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      const { nodes, system } = messageBody(`see <${name}>new Foo()</${name}> here`);
      assert.equal(system, false);
      assert.ok(nodes.every((n: unknown) => n instanceof ElementoFalso), `${name}: every piece is a node`);
      assert.match(text(nodes), new RegExp(`<${name}>new Foo\\(\\)</${name}>`));
    }
    assert.match(text(messageBody('<constructor>cut…').nodes), /<constructor>cut/);
  });

  test('an unknown tag is the person\'s text, not a card', () => {
    const { nodes, system } = messageBody('<foo>bar</foo>');
    assert.equal(system, false);
    assert.equal(byClass(nodes, 'sd-note').length, 0);
    assert.match(text(nodes), /<foo>bar<\/foo>/);
  });
});
