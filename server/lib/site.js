import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Same contact details the website uses (data/site.json is the single source).
export const site = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../data/site.json'), 'utf8'));
