import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const docsDir = join(root, 'docs');
const publicDocsDir = join(root, 'public', 'docs');

function mdToHtml(md) {
  let html = md;

  // Escape HTML
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (backticks)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
    return '<pre><code class="language-' + lang + '">' + code.trim() + '</code></pre>';
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr />');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered lists
  html = html.replace(/^• (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^(?=<li>)/gm, '<ul>');
  html = html.replace(/(?<=<\/li>)\n?(?=<li>)/gm, '');
  html = html.replace(/(?<=<\/li>)\n?(?!\s*<(?:ul|li|h[1-6]|hr|<))/gm, '</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (wrap remaining text in <p>)
  html = html.split('\n\n').map(function (block) {
    block = block.trim();
    if (!block) return '';
    if (block.startsWith('<')) return block;
    return '<p>' + block.replace(/\n/g, '<br />') + '</p>';
  }).join('\n');

  return html;
}

function processDocs() {
  mkdirSync(publicDocsDir, { recursive: true });

  const files = readdirSync(docsDir).filter(function (f) {
    return f.endsWith('.md');
  });

  files.forEach(function (file) {
    const md = readFileSync(join(docsDir, file), 'utf-8');
    const name = file.replace(/\.md$/, '');
    const body = mdToHtml(md);

    const html = '<!doctype html>\n' +
      '<html lang="en" data-theme="dark">\n' +
      '<head>\n' +
      '  <meta charset="UTF-8" />\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
      '  <title>' + name + ' — Orion Wallet Docs</title>\n' +
      '  <style>\n' +
      '    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.7; color: #e7e7ef; background: #0a0a0f; }\n' +
      '    a { color: #6d6dff; }\n' +
      '    code { background: #1a1a2e; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }\n' +
      '    pre { background: #1a1a2e; padding: 1rem; border-radius: 8px; overflow-x: auto; }\n' +
      '    pre code { background: none; padding: 0; }\n' +
      '    h1 { border-bottom: 1px solid #26263a; padding-bottom: 0.5rem; }\n' +
      '    h2 { margin-top: 2rem; }\n' +
      '    h3 { margin-top: 1.5rem; }\n' +
      '    hr { border: none; border-top: 1px solid #26263a; margin: 2rem 0; }\n' +
      '    ul { padding-left: 1.5rem; }\n' +
      '    li { margin: 0.25rem 0; }\n' +
      '    blockquote { border-left: 3px solid #6d6dff; padding-left: 1rem; margin-left: 0; color: #8a8aa0; }\n' +
      '    table { border-collapse: collapse; margin: 1rem 0; }\n' +
      '    th, td { border: 1px solid #26263a; padding: 0.5rem 1rem; text-align: left; }\n' +
      '    th { background: #15151f; }\n' +
      '  </style>\n' +
      '</head>\n' +
      '<body>\n' +
      body + '\n' +
      '</body>\n' +
      '</html>\n';

    writeFileSync(join(publicDocsDir, name + '.html'), html);
  });

  // Landing page for /docs. Generated rather than checked-for: the previous
  // version called statSync() on a file that does not exist on a clean
  // checkout, which threw and aborted the whole build.
  const landing = files.includes('USER_GUIDE.md') ? 'USER_GUIDE.html' : files[0].replace(/\.md$/, '.html');
  writeFileSync(
    join(publicDocsDir, 'index.html'),
    '<!doctype html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '  <meta charset="UTF-8" />\n' +
      '  <meta http-equiv="refresh" content="0; url=' + landing + '" />\n' +
      '  <title>Docs — Orion Wallet</title>\n' +
      '</head>\n' +
      '<body>\n' +
      '  <p>Redirecting to <a href="' + landing + '">the documentation</a>…</p>\n' +
      '</body>\n' +
      '</html>\n',
  );

  console.log('Built ' + files.length + ' doc pages + index to public/docs/');
}

processDocs();
