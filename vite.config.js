import { defineConfig } from 'vite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const root = resolve(import.meta.dirname, 'site');
const site = JSON.parse(readFileSync(resolve(import.meta.dirname, 'data/site.json'), 'utf8'));
const images = JSON.parse(readFileSync(resolve(import.meta.dirname, 'data/images.json'), 'utf8'));

// Every index.html under site/ (plus 404.html) is its own page.
function findPages(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name === 'src') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) findPages(full, out);
    else if (name.endsWith('.html')) {
      const key = relative(root, full).replace(/\/?index\.html$/, '').replace(/\.html$/, '') || 'home';
      out[key] = full;
    }
  }
  return out;
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// <img data-img="slug"> -> src, srcset, width, height from data/images.json
function expandImages(html) {
  return html.replace(/<img\b([^>]*?)\sdata-img="([a-z0-9-]+)"([^>]*)>/g, (m, a, slug, b) => {
    const img = images[slug];
    if (!img) throw new Error(`Unknown image "${slug}"`);
    const set = img.sizes.map((s) => `/images/${slug}-${s}.webp ${Math.min(s, img.w)}w`).join(', ');
    const def = img.sizes.find((s) => s >= 1280) ?? img.sizes.at(-1);
    const rest = a + b;
    const sizes = /\ssizes=/.test(rest) ? '' : ' sizes="100vw"';
    const loading = /\sloading=/.test(rest) ? '' : ' loading="lazy" decoding="async"';
    return `<img${a} src="/images/${slug}-${def}.webp" srcset="${set}"${sizes} width="${img.w}" height="${img.h}"${loading}${b}>`;
  });
}

// <!-- include:header nav=about --> pulls in site/_partials/header.html
function includes(html) {
  return html.replace(/<!--\s*include:([a-z-]+)((?:\s+[a-z]+=[^\s]+)*)\s*-->/g, (m, name, args) => {
    const vars = Object.fromEntries([...args.matchAll(/([a-z]+)=([^\s]+)/g)].map((x) => [x[1], x[2]]));
    let part = readFileSync(join(root, '_partials', `${name}.html`), 'utf8');
    part = part.replace(/\{\{current:([a-z-]+)\}\}/g, (_, key) => (vars.nav === key ? ' aria-current="page"' : ''));
    return includes(part);
  });
}

function pinusHtml() {
  return {
    name: 'pinus-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        html = includes(html);
        html = html.replace(/\{\{site\.([a-zA-Z]+)\}\}/g, (_, k) => {
          if (!(k in site)) throw new Error(`Unknown site key ${k}`);
          return attr(site[k]);
        });
        html = html.replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
        return expandImages(html);
      },
    },
    configureServer(server) {
      // Mirror the production server: /about -> /about/
      server.middlewares.use((req, res, next) => {
        const [path, q] = req.url.split('?');
        const pages = findPages(root);
        const key = path.replace(/^\/|\/$/g, '');
        if (!path.endsWith('/') && !path.includes('.') && pages[key]) {
          res.statusCode = 301;
          res.setHeader('Location', `${path}/${q ? `?${q}` : ''}`);
          return res.end();
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir: resolve(import.meta.dirname, 'public'),
  appType: 'mpa',
  plugins: [pinusHtml()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: findPages(root) },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
