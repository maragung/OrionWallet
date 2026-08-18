import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const docsDir = join(root, 'docs');
const publicDocsDir = join(root, 'public', 'docs');

const CODE_MARK = '\u0000CODE';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline formatting: code, links, bold, italic. Input must already be escaped. */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `${CODE_MARK}${codes.length - 1}\u0000`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return out.replace(
    new RegExp(`${CODE_MARK}(\\d+)\\u0000`, 'g'),
    (_, i) => `<code>${codes[Number(i)]}</code>`,
  );
}

/** A GFM pipe-table separator, e.g. |---|:--:|---:| */
function isTableSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes('-');
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function alignmentsFrom(separator) {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function cellAttr(alignments, index) {
  const align = alignments[index];
  return align ? ` style="text-align:${align}"` : '';
}

/**
 * GitHub-compatible heading slug, so the `## Contents` links in the markdown
 * resolve in the generated page too. Matches GitHub's rules: lowercase, drop
 * punctuation and emoji outright (no hyphen in their place), spaces to hyphens.
 * Input is already HTML-escaped, hence the entity strip.
 */
function slugify(text) {
  const slug = text
    .replace(/&(?:[a-z]+|#\d+);/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug || 'section';
}

/** Deduplicate repeated slugs the way GitHub does: `-1`, `-2`, … */
function uniqueSlug(seen, base) {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Markdown → HTML.
 *
 * A line-oriented block parser rather than a pile of global regexes: pipe
 * tables, blockquotes and dash lists all need block context, and the previous
 * regex-only version emitted raw "| cell | cell |" text inside <p>.
 */
export function mdToHtml(md) {
  const fences = [];
  // Pull fenced code out first so no inline rule can touch its contents.
  const withoutFences = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(
      `<pre><code class="language-${lang}">${escapeHtml(code.replace(/\n+$/, ''))}</code></pre>`,
    );
    return `${CODE_MARK}FENCE${fences.length - 1}\u0000`;
  });

  const lines = escapeHtml(withoutFences).split('\n');
  const out = [];
  const slugs = new Map();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Restored verbatim (fenced code placeholder).
    if (trimmed.startsWith(`${CODE_MARK}FENCE`)) {
      out.push(trimmed);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Heading. The id is what makes in-page `#anchor` links work.
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const id = uniqueSlug(slugs, slugify(heading[2]));
      out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table: a pipe row followed by a separator row
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const alignments = alignmentsFrom(lines[i + 1]);
      const header = splitRow(trimmed);
      i += 2;

      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(splitRow(lines[i]));
        i++;
      }

      const head = header
        .map((cell, idx) => `<th${cellAttr(alignments, idx)}>${inline(cell)}</th>`)
        .join('');
      const rows = body
        .map(
          (row) =>
            `<tr>${row
              .map((cell, idx) => `<td${cellAttr(alignments, idx)}>${inline(cell)}</td>`)
              .join('')}</tr>`,
        )
        .join('\n');

      out.push(
        `<div class="table-wrap">\n<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n</div>`,
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('&gt;')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('&gt;')) {
        quoted.push(inline(lines[i].trim().replace(/^&gt;\s?/, '')));
        i++;
      }
      out.push(`<blockquote>${quoted.join('<br />')}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^([-*•])\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^([-*•])\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].trim().replace(/^([-*•])\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>\n${items.join('\n')}\n</ol>`);
      continue;
    }

    // Paragraph: consecutive plain lines
    const paragraph = [];
    while (i < lines.length) {
      const current = lines[i].trim();
      if (
        !current ||
        current.startsWith('|') ||
        current.startsWith('&gt;') ||
        current.startsWith(`${CODE_MARK}FENCE`) ||
        /^(#{1,4})\s+/.test(current) ||
        /^([-*•])\s+/.test(current) ||
        /^\d+\.\s+/.test(current) ||
        /^(-{3,}|\*{3,})$/.test(current)
      ) {
        break;
      }
      paragraph.push(inline(current));
      i++;
    }
    if (paragraph.length) out.push(`<p>${paragraph.join('<br />')}</p>`);
  }

  return out
    .join('\n')
    .replace(new RegExp(`${CODE_MARK}FENCE(\\d+)\\u0000`, 'g'), (_, idx) => fences[Number(idx)]);
}

const PAGE_STYLE = `
    :root {
      --bg: #0a0a0f;
      --text: #e7e7ef;
      --text-muted: #8a8aa0;
      --accent: #6d6dff;
      --code-bg: #1a1a2e;
      --border: #26263a;
      --blockquote-border: #6d6dff;
      --th-bg: #15151f;
    }
    [data-theme="light"] {
      --bg: #fafafa;
      --text: #1a1a2e;
      --text-muted: #666;
      --accent: #2a5db0;
      --code-bg: #f0f0f0;
      --border: #ddd;
      --blockquote-border: #999;
      --th-bg: #e8e8e8;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 820px; margin: 0 auto; padding: 2rem; line-height: 1.7; color: var(--text); background: var(--bg); }
    a { color: var(--accent); }
    code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h2 { margin-top: 2rem; }
    h3 { margin-top: 1.5rem; }
    h4 { margin-top: 1.25rem; }
    hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    ul, ol { padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    blockquote { border-left: 3px solid var(--blockquote-border); padding-left: 1rem; margin-left: 0; color: var(--text-muted); }
    .table-wrap { overflow-x: auto; margin: 1rem 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--border); padding: 0.5rem 0.85rem; text-align: left; vertical-align: top; }
    th { background: var(--th-bg); font-weight: 600; }
    tbody tr:nth-child(even) { background: color-mix(in srgb, var(--th-bg) 45%, transparent); }
`;

const THEME_SYNC = `
    (function() {
      function apply(t) { document.documentElement.setAttribute("data-theme", t); }
      try { var t = parent.document.documentElement.getAttribute("data-theme"); if (t) apply(t); } catch(e) {}
      try { new MutationObserver(function(m) { m.forEach(function(x) { if (x.attributeName === "data-theme") apply(parent.document.documentElement.getAttribute("data-theme")); }); }).observe(parent.document.documentElement, { attributes: true }); } catch(e) {}
    })();
`;

function page(title, body) {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    '  <title>' +
    title +
    ' — Orion Wallet Docs</title>\n' +
    '  <style>' +
    PAGE_STYLE +
    '  </style>\n' +
    '  <script>' +
    THEME_SYNC +
    '  </script>\n' +
    '</head>\n<body>\n' +
    body +
    '\n</body>\n</html>\n'
  );
}

function processDocs() {
  mkdirSync(publicDocsDir, { recursive: true });

  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));

  files.forEach((file) => {
    const md = readFileSync(join(docsDir, file), 'utf-8');
    const name = file.replace(/\.md$/, '');
    writeFileSync(join(publicDocsDir, name + '.html'), page(name, mdToHtml(md)));
  });

  // Landing page for /docs. Generated rather than checked-for: the previous
  // version called statSync() on a file that does not exist on a clean
  // checkout, which threw and aborted the whole build.
  const landing = files.includes('USER_GUIDE.md')
    ? 'USER_GUIDE.html'
    : files[0].replace(/\.md$/, '.html');
  writeFileSync(
    join(publicDocsDir, 'index.html'),
    '<!doctype html>\n<html lang="en">\n<head>\n' +
      '  <meta charset="UTF-8" />\n' +
      '  <meta http-equiv="refresh" content="0; url=' +
      landing +
      '" />\n' +
      '  <title>Docs — Orion Wallet</title>\n' +
      '</head>\n<body>\n' +
      '  <p>Redirecting to <a href="' +
      landing +
      '">the documentation</a>…</p>\n' +
      '</body>\n</html>\n',
  );

  console.log('Built ' + files.length + ' doc pages + index to public/docs/');
}

// Only build when run directly, so the converter can be imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  processDocs();
}