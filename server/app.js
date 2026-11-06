// The Express app: security headers, compression and /api. Imported by
//   server/index.js  - a normal Node server (also serves the built site)
//   api/index.js     - the Vercel function
import express from 'express';
import compression from 'compression';
import { api } from './routes/api.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ?? (process.env.VERCEL ? 1 : 'loopback'));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(compression());

app.use('/api', api);

export default app;
