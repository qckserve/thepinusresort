// The Pinus Resort: standalone Node server (any host that runs Node, and local development).
// Development: serves only /api (Vite serves the pages and proxies /api here).
// Production: serves the built site from dist/ plus /api, from one Node process.
// On Vercel this file is not used: api/index.js exports the same app as a function.
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from './app.js';
import { startScheduler } from './lib/scheduler.js';

const PORT = Number(process.env.PORT || 8787);
const prod = process.env.NODE_ENV === 'production';
const dist = resolve(import.meta.dirname, '../dist');

if (prod) {
  if (!existsSync(dist)) throw new Error('dist/ is missing. Run "npm run build" first.');

  // Old WordPress links, including the misspelt one in the old footer.
  const redirects = { '/accomodation': '/accommodation/', '/accomodation/': '/accommodation/', '/home': '/', '/home/': '/', '/login': '/admin/', '/staff': '/admin/' };
  app.use((req, res, next) => {
    const to = redirects[req.path.toLowerCase()];
    if (to) return res.redirect(301, to);
    // /about -> /about/ (pages live in folders)
    if (!req.path.endsWith('/') && !req.path.includes('.') && existsSync(resolve(dist, `.${req.path}`, 'index.html'))) {
      return res.redirect(301, `${req.path}/${req.url.slice(req.path.length)}`);
    }
    next();
  });
  // Hashed build assets never change, so cache them for a year.
  app.use('/assets', express.static(resolve(dist, 'assets'), { immutable: true, maxAge: '365d' }));
  app.use('/images', express.static(resolve(dist, 'images'), { maxAge: '30d' }));
  app.use(express.static(dist, { maxAge: '1h', extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(resolve(dist, '404.html')));
}

if (process.env.DISABLE_JOBS !== '1') startScheduler();

app.listen(PORT, () => console.log(`[pinus] ${prod ? 'production' : 'api'} server on http://localhost:${PORT}`));
