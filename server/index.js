// The Pinus Resort: web server.
// Development: serves only /api (Vite serves the pages and proxies /api here).
// Production: serves the built site from dist/ plus /api, from one Node process.
import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './routes/api.js';
import { bootstrapOwner } from './lib/auth.js';
import { startScheduler } from './lib/scheduler.js';

const PORT = Number(process.env.PORT || 8787);
const prod = process.env.NODE_ENV === 'production';
const dist = resolve(import.meta.dirname, '../dist');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (prod) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(compression());

app.use('/api', api);

if (prod) {
  if (!existsSync(dist)) throw new Error('dist/ is missing. Run "npm run build" first.');

  // Old WordPress links, including the misspelt one in the old footer.
  const redirects = {
    '/accomodation': '/accommodation/',
    '/accomodation/': '/accommodation/',
    '/home': '/',
    '/home/': '/',
  };
  app.use((req, res, next) => {
    const to = redirects[req.path.toLowerCase()];
    if (to) return res.redirect(301, to);
    // /about -> /about/ (pages live in folders)
    if (!req.path.endsWith('/') && !req.path.includes('.') && existsSync(resolve(dist, `.${req.path}`, 'index.html'))) {
      const q = req.url.slice(req.path.length);
      return res.redirect(301, `${req.path}/${q}`);
    }
    next();
  });

  // Hashed build assets never change, so cache them for a year.
  app.use('/assets', express.static(resolve(dist, 'assets'), { immutable: true, maxAge: '365d' }));
  app.use('/images', express.static(resolve(dist, 'images'), { maxAge: '30d' }));
  app.use(express.static(dist, { maxAge: '1h', extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(resolve(dist, '404.html')));
}

bootstrapOwner();
if (process.env.DISABLE_JOBS !== '1') startScheduler();

app.listen(PORT, () => console.log(`[pinus] ${prod ? 'production' : 'api'} server on http://localhost:${PORT}`));
