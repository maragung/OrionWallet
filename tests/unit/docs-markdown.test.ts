import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs build script, no type declarations
import { mdToHtml } from '../../scripts/build-docs.mjs';

const toHtml = mdToHtml as (md: string) => string;

describe('docs markdown → HTML', () => {
  it('renders a pipe table as a real table instead of raw pipes', () => {
    const html = toHtml(
      ['| Threat | Mitigation |', '|---|---|', '| Key leak | No backend |'].join('\n'),
    );

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Threat</th>');
    expect(html).toContain('<td>No backend</td>');
    expect(html).not.toMatch(/<p>[^<]*\|/);
  });

  it('keeps a leading empty header cell', () => {
    const html = toHtml(['| | Phrase | PIN |', '|---|---|---|', '| Purpose | a | b |'].join('\n'));

    expect(html).toContain('<thead><tr><th></th><th>Phrase</th><th>PIN</th></tr></thead>');
  });

  it('honours column alignment markers', () => {
    const html = toHtml(['| L | C | R |', '|:---|:--:|---:|', '| a | b | c |'].join('\n'));

    expect(html).toContain('<th style="text-align:left">L</th>');
    expect(html).toContain('<th style="text-align:center">C</th>');
    expect(html).toContain('<th style="text-align:right">R</th>');
  });

  it('applies inline formatting inside table cells', () => {
    const html = toHtml(['| Cmd | Note |', '|---|---|', '| `npm run x` | **bold** |'].join('\n'));

    expect(html).toContain('<td><code>npm run x</code></td>');
    expect(html).toContain('<td><strong>bold</strong></td>');
  });

  it('renders dash lists, ordered lists and blockquotes', () => {
    const html = toHtml(['- one', '- two', '', '1. first', '', '> quoted'].join('\n'));

    expect(html).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(html).toContain('<ol>\n<li>first</li>\n</ol>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
  });

  it('leaves fenced code untouched by inline rules', () => {
    const html = toHtml(['```ts', 'const a = **not bold**;', '```'].join('\n'));

    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const a = **not bold**;');
    expect(html).not.toContain('<strong>');
  });

  it('escapes HTML in prose and code', () => {
    const html = toHtml('Use <script>alert(1)</script> carefully');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders headings and horizontal rules', () => {
    const html = toHtml(['# Title', '', '## Section', '', '---', '', 'Body text'].join('\n'));

    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<h2 id="section">Section</h2>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Body text</p>');
  });

  it('gives every heading an id so the Contents links resolve', () => {
    // The exact slugs the guides link to. Without these the `## Contents` list
    // at the top of each page is 17 dead links.
    const html = toHtml(
      [
        '## Contacts (address book)',
        '',
        '## Watch-only accounts',
        '',
        '## Encrypted balance (FHE)',
        '',
        '## Connecting to a dApp',
      ].join('\n'),
    );

    expect(html).toContain('id="contacts-address-book"');
    expect(html).toContain('id="watch-only-accounts"');
    expect(html).toContain('id="encrypted-balance-fhe"');
    expect(html).toContain('id="connecting-to-a-dapp"');
  });

  it('drops emoji and inline markup from a slug without leaving stray hyphens', () => {
    const html = toHtml(
      ['### The header shows "Insecure RPC"', '', '### `npm run docs:build`'].join('\n'),
    );

    expect(html).toContain('id="the-header-shows-insecure-rpc"');
    expect(html).toContain('id="npm-run-docsbuild"');
  });

  it('deduplicates repeated headings instead of emitting the same id twice', () => {
    const html = toHtml(['## Exporting', '', '## Exporting', '', '## Exporting'].join('\n'));

    expect(html).toContain('id="exporting"');
    expect(html).toContain('id="exporting-1"');
    expect(html).toContain('id="exporting-2"');
  });

  it('renders links', () => {
    const html = toHtml('See [the docs](https://example.com/x) now');

    expect(html).toContain('<a href="https://example.com/x">the docs</a>');
  });
});
