/* The fake DOM selector engine accepts what the browser accepts (and production uses), and throws a SyntaxError only for
what is truly invalid (#566). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso } from './fake-dom.ts';

function tree() {
  const root = new ElementoFalso('div');
  const make = (tag: string, attrs: Record<string, string>, parent: ElementoFalso = root) => {
    const node = new ElementoFalso(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };
  const link = make('a', { href: '#top', class: 'nav' });
  const external = make('a', { href: 'https://example.com/x.pdf', rel: 'noopener external' });
  const button = make('button', { id: 'go', 'data-kind': 'primary' });
  const panel = make('section', { id: 'update-panel' });
  const inner = make('span', {}, panel);
  const version = make('i', { class: 'up-version' });
  return { root, link, external, button, panel, inner, version };
}

describe('selector lists', () => {
  test('querySelectorAll takes a comma-separated list, in document order, once per element', () => {
    const t = tree();
    assert.deepEqual(t.root.querySelectorAll('a, button'), [t.link, t.external, t.button]);
    assert.deepEqual(t.root.querySelectorAll('a, .nav'), [t.link, t.external]);
  });

  test('querySelector takes the first of a list', () => {
    const t = tree();
    assert.equal(t.root.querySelector('button, a'), t.link);
  });

  test('closest takes a list: the nearest ancestor that matches any of them', () => {
    const t = tree();
    assert.equal(t.inner.closest('#update-panel, .up-version'), t.panel);
    assert.equal(t.version.closest('#update-panel, .up-version'), t.version);
    assert.equal(t.link.closest('a, button'), t.link);
    assert.equal(t.link.closest('button, .nothing'), null);
  });

  test('a comma inside a quoted value is not a separator', () => {
    const t = tree();
    t.button.setAttribute('data-kind', 'a, b');
    assert.deepEqual(t.root.querySelectorAll('[data-kind="a, b"]'), [t.button]);
  });
});

describe('attribute operators and quoting', () => {
  test('^=, $=, *= and ~=', () => {
    const t = tree();
    assert.deepEqual(t.root.querySelectorAll('a[href^="#"]'), [t.link]);
    assert.deepEqual(t.root.querySelectorAll('a[href$=".pdf"]'), [t.external]);
    assert.deepEqual(t.root.querySelectorAll('a[href*="example"]'), [t.external]);
    assert.deepEqual(t.root.querySelectorAll('a[rel~="external"]'), [t.external]);
    assert.deepEqual(t.root.querySelectorAll('a[rel~="extern"]'), []);
  });

  test('single-quoted and unquoted values', () => {
    const t = tree();
    assert.deepEqual(t.root.querySelectorAll("[data-kind='primary']"), [t.button]);
    assert.deepEqual(t.root.querySelectorAll('[data-kind=primary]'), [t.button]);
    assert.deepEqual(t.root.querySelectorAll("a[href^='#']"), [t.link]);
  });

  test('the value of an attribute is never read as a class or an id', () => {
    const t = tree();
    t.button.setAttribute('data-alert', 'volume-full:/Volumes/My.Drive');
    assert.deepEqual(t.root.querySelectorAll('[data-alert="volume-full:/Volumes/My.Drive"]'), [t.button]);
    assert.deepEqual(t.root.querySelectorAll('[data-alert="volume-full\\:\\/Volumes\\/My\\.Drive"]'), [t.button]);
    assert.deepEqual(t.root.querySelectorAll('[data-alert="x#y.z"]'), []);
  });
});

describe('what is truly invalid', () => {
  test('an unterminated value, an empty list item and a stray token throw a SyntaxError', () => {
    const t = tree();
    for (const bad of ['[data-kind="open', 'a,', ', a', 'a,,b', '[data-kind="a" x]', '']) {
      assert.throws(() => t.root.querySelectorAll(bad), SyntaxError, `'${bad}'`);
    }
    assert.throws(() => t.link.closest('a,'), SyntaxError);
  });
});
