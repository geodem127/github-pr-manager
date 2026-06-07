export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SENTINEL = '@@MDBLOCK';

/** Minimal, dependency-free GitHub-flavored-ish markdown renderer for webviews. */
export function renderMarkdown(src: string | null | undefined): string {
  if (!src) return '<p class="muted">No description provided.</p>';

  // Pull fenced code blocks out before any other processing.
  const blocks: string[] = [];
  let text = src.replace(/```[\w-]*\r?\n([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `${SENTINEL}${blocks.length - 1}@@`;
  });

  text = escapeHtml(text);

  text = text
    .replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\.\s+(.*)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> runs in <ul>.
  text = text.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>\n`);

  // Paragraphs: blank-line separated chunks that aren't already block elements.
  text = text
    .split(/\n{2,}/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return '';
      if (/^<(h\d|ul|ol|pre|blockquote|p)/.test(t) || t.startsWith(SENTINEL)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // Restore code blocks.
  text = text.replace(new RegExp(`${SENTINEL}(\\d+)@@`, 'g'), (_m, i) => blocks[Number(i)]);
  return text;
}
