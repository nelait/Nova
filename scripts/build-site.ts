// Builds the product site and docs into site/ (static, host anywhere) and a copy
// in dist/artifact/ shaped for publishing as a Claude artifact.
//
//   npm run site:build
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';

const root = join(import.meta.dirname, '..');
const out = join(root, 'site');
const art = join(root, 'dist', 'artifact');
const GITHUB = 'https://github.com/nelait/Nova';

interface Page { md: string; slug: string; group: string; blurb: string }
const PAGES: Page[] = [
  { md: 'getting-started.md', slug: 'getting-started', group: 'Start here', blurb: 'From checkout to a completed plan installation in fifteen minutes.' },
  { md: 'concepts.md', slug: 'concepts', group: 'Start here', blurb: 'Plans, cases, tasks, the four kinds of step, and how work flows.' },
  { md: 'playbooks.md', slug: 'playbooks', group: 'Build processes', blurb: 'Steps, actions, conditions, templates and per-client variations.' },
  { md: 'RULES.md', slug: 'rules', group: 'Build processes', blurb: 'Validations, calculations and decision tables as configuration.' },
  { md: 'INTEGRATIONS.md', slug: 'integrations', group: 'Build processes', blurb: 'Connect the recordkeeper and other systems without adapter code.' },
  { md: 'AGENTS.md', slug: 'agents', group: 'Build processes', blurb: 'AI agents that propose results for people to approve.' },
  { md: 'users-and-routing.md', slug: 'users-and-routing', group: 'Build processes', blurb: 'Skills, levels, SCIM import, and how work is routed.' },
  { md: 'sign-in.md', slug: 'sign-in', group: 'Operate', blurb: 'Single sign-on with OpenID Connect or SAML, roles and sessions.' },
  { md: 'deployment.md', slug: 'deployment', group: 'Operate', blurb: 'Settings, and what to put in place before production.' },
  { md: 'api.md', slug: 'api', group: 'Operate', blurb: 'Every HTTP endpoint, with request shapes.' },
  { md: 'ARCHITECTURE.md', slug: 'architecture', group: 'Operate', blurb: 'Components, design decisions and the task state machine.' },
  { md: 'faq.md', slug: 'faq', group: 'Operate', blurb: 'Adoption questions and troubleshooting.' },
];
const SCREENS: Record<string, string> = {
  'agent-proposal.png': '17-agent-proposal.png',
  'rules.png': '12-rules-screen.png',
  'integrations.png': '14-integrations.png',
};

const slugByFile = new Map(PAGES.map((p) => [p.md.toLowerCase(), p.slug]));
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderMarkdown(md: string): { title: string; html: string; toc: { id: string; text: string }[] } {
  const toc: { id: string; text: string }[] = [];
  let title = '';
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const id = slugify(inner);
        if (token.depth === 1) {
          title ||= inner.replace(/<[^>]+>/g, '');
          return `<h1>${inner}</h1>\n`;
        }
        if (token.depth === 2) toc.push({ id, text: inner.replace(/<[^>]+>/g, '') });
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
    },
  });
  let html = marked.parse(md) as string;
  // Links between docs: FOO.md#x -> foo.html#x
  html = html.replace(/href="([^"#:]+\.md)(#[^"]*)?"/gi, (m, file: string, hash = '') => {
    const slug = slugByFile.get(file.split('/').pop()!.toLowerCase());
    return slug ? `href="${slug}.html${hash}"` : `href="${GITHUB}/blob/main/docs/${file}${hash}"`;
  });
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { title, html, toc };
}

const HEAD = (title: string, desc: string, css: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="claude:viewport-fit-sides" content="cover" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Familjen+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" />
<link rel="stylesheet" href="${css}" />
<script>try { const t = localStorage.getItem('planops.site.theme'); if (t && t !== 'system') document.documentElement.dataset.theme = t; } catch {}</script>
</head>
<body>
`;
const THEME_SCRIPT = readFileSync(join(root, 'site-src', 'landing.html'), 'utf8').match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/)![0];
const LOGO = `<svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="7" fill="var(--accent)"/><path d="M8 9h14M8 15h9M8 21h5" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"/><circle cx="21" cy="20" r="3.2" fill="var(--brass)"/></svg>`;
const topbar = (home: string, current: 'docs' | 'none') => `<header class="topbar">
  <div class="wrap">
    <a class="logo" href="${home}">${LOGO}Plan Ops Hub</a>
    <nav class="topnav" aria-label="Site">
      <a href="${home}#how">How it works</a>
      <a href="index.html"${current === 'docs' ? ' aria-current="page"' : ''}>Docs</a>
      <a href="${GITHUB}">GitHub</a>
    </nav>
    <div class="theme-toggle" role="group" aria-label="Theme"><button data-theme-choice="system">Auto</button><button data-theme-choice="light">Light</button><button data-theme-choice="dark">Dark</button></div>
  </div>
</header>`;

function docNav(current: string): string {
  const groups = [...new Set(PAGES.map((p) => p.group))];
  return `<nav class="docnav" aria-label="Documentation"><details open><summary>Documentation</summary>
    <h4>Overview</h4><a href="index.html"${current === 'index' ? ' aria-current="page"' : ''}>Docs home</a>
    ${groups.map((g) => `<h4>${g}</h4>${PAGES.filter((p) => p.group === g).map((p) => `<a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ''}>${esc(titles.get(p.slug)!)}</a>`).join('')}`).join('\n')}
  </details></nav>`;
}

// ---------------------------------------------------------------- build
rmSync(out, { recursive: true, force: true });
rmSync(art, { recursive: true, force: true });
for (const d of [join(out, 'assets', 'screens'), join(out, 'docs'), join(art, 'assets', 'screens'), join(art, 'docs')]) mkdirSync(d, { recursive: true });

const css = readFileSync(join(root, 'public', 'theme.css'), 'utf8') + '\n' + readFileSync(join(root, 'site-src', 'site.css'), 'utf8');
for (const dir of [out, art]) {
  writeFileSync(join(dir, 'assets', 'site.css'), css);
  for (const [to, from] of Object.entries(SCREENS)) copyFileSync(join(root, 'docs', 'screenshots', from), join(dir, 'assets', 'screens', to));
}

// Landing page: a full document for site/, the bare fragment for the artifact.
const landing = readFileSync(join(root, 'site-src', 'landing.html'), 'utf8');
const [headPart, bodyPart] = landing.split('<!-- body -->');
writeFileSync(join(out, 'index.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n${headPart.trim()}\n</head>\n<body>\n${bodyPart.trim()}\n</body>\n</html>\n`);
writeFileSync(join(art, 'index.html'), `${headPart.trim()}\n${bodyPart.trim()}\n`);

// Docs pages.
const rendered = PAGES.map((p) => ({ p, ...renderMarkdown(readFileSync(join(root, 'docs', p.md), 'utf8')) }));
const titles = new Map(rendered.map((r) => [r.p.slug, r.title]));

function docPage(home: string, r: (typeof rendered)[number], i: number): string {
  const prev = rendered[i - 1];
  const next = rendered[i + 1];
  return `${HEAD(`${r.title} · Plan Ops Hub docs`, r.p.blurb, '../assets/site.css')}${topbar(home, 'docs')}
<div class="wrap docs">
  ${docNav(r.p.slug)}
  <article class="doc">
${r.html}
    <nav class="pager" aria-label="Previous and next">
      ${prev ? `<a href="${prev.p.slug}.html"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a href="${next.p.slug}.html" style="text-align:right"><small>Next</small>${esc(next.title)}</a>` : ''}
    </nav>
  </article>
  ${r.toc.length > 1 ? `<aside class="toc"><b>On this page</b>${r.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}</aside>` : ''}
</div>
${THEME_SCRIPT}
</body>
</html>
`;
}

function docHome(home: string): string {
  return `${HEAD('Plan Ops Hub docs', 'Guides and reference for adopting Plan Ops Hub.', '../assets/site.css')}${topbar(home, 'docs')}
<div class="wrap docs">
  ${docNav('index')}
  <article class="doc">
    <div class="eyebrow">Documentation</div>
    <h1>Adopt Plan Ops Hub</h1>
    <p>Start with the demo, learn the four kinds of step, then connect your recordkeeper and adapt the processes to your service model.</p>
    <div class="doc-home">
      ${rendered.map((r) => `<a href="${r.p.slug}.html"><b>${esc(r.title)}</b><span>${esc(r.p.blurb)}</span></a>`).join('\n      ')}
    </div>
  </article>
</div>
${THEME_SCRIPT}
</body>
</html>
`;
}

for (const [dir, home] of [[out, '../index.html'], [art, '../']] as const) {
  writeFileSync(join(dir, 'docs', 'index.html'), docHome(home));
  rendered.forEach((r, i) => writeFileSync(join(dir, 'docs', `${r.p.slug}.html`), docPage(home, r, i)));
}
// Fail the build on any broken link between docs pages or to a missing section.
const broken: string[] = [];
const pageHtml = new Map<string, string>([['index.html', readFileSync(join(out, 'docs', 'index.html'), 'utf8')]]);
for (const r of rendered) pageHtml.set(`${r.p.slug}.html`, readFileSync(join(out, 'docs', `${r.p.slug}.html`), 'utf8'));
for (const [name, html] of pageHtml) {
  for (const [, target, hash] of html.matchAll(/href="([a-z0-9-]*\.html)?(#[^"]*)?"/g)) {
    if (!target && !hash) continue;
    const page = target ?? name;
    const doc = pageHtml.get(page);
    if (!doc) { broken.push(`${name} -> ${page}`); continue; }
    if (hash && hash !== '#' && !doc.includes(`id="${hash.slice(1)}"`)) broken.push(`${name} -> ${page}${hash}`);
  }
}
const landingHtml = readFileSync(join(out, 'index.html'), 'utf8');
for (const [, target] of landingHtml.matchAll(/href="docs\/([a-z0-9-]+\.html)"/g)) if (!pageHtml.has(target)) broken.push(`index.html -> docs/${target}`);
if (broken.length) {
  console.error('Broken links:\n  ' + broken.join('\n  '));
  process.exit(1);
}
console.log(`Built ${rendered.length + 2} pages into site/ and dist/artifact/; all internal links resolve.`);
