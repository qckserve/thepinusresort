// Local MongoDB for development: a one-node replica set (needed for transactions),
// data kept in data/mongo. Uses the mongod binary that mongodb-memory-server downloads
// on first run, so nothing has to be installed by hand. Production uses MONGODB_URI (Atlas).
//
//   node scripts/dev-mongo.mjs            -> mongodb://127.0.0.1:27027/?replicaSet=pinus
import { MongoBinary } from 'mongodb-memory-server-core';
import { MongoClient } from 'mongodb';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.DEV_MONGO_PORT || 27027);
const dbPath = resolve(import.meta.dirname, '../data/mongo');
mkdirSync(dbPath, { recursive: true });

const bin = await MongoBinary.getPath();
const mongod = spawn(bin, ['--dbpath', dbPath, '--port', String(PORT), '--bind_ip', '127.0.0.1', '--replSet', 'pinus', '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
const stop = () => { mongod.kill('SIGINT'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
mongod.on('exit', (code) => { console.log(`[mongo] stopped (${code})`); process.exit(code ?? 0); });

// Wait for mongod, then initiate the replica set once (it is remembered in dbPath).
const direct = `mongodb://127.0.0.1:${PORT}/?directConnection=true`;
for (let i = 0; i < 60; i++) {
  try {
    const c = await MongoClient.connect(direct, { serverSelectionTimeoutMS: 1000 });
    const admin = c.db('admin');
    try {
      await admin.command({ replSetGetStatus: 1 });
    } catch (e) {
      if (e.codeName === 'NotYetInitialized') {
        await admin.command({ replSetInitiate: { _id: 'pinus', members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] } });
      } else throw e;
    }
    // Wait until this node is primary.
    for (let j = 0; j < 40; j++) {
      const s = await admin.command({ hello: 1 });
      if (s.isWritablePrimary) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await c.close();
    console.log(`[mongo] ready on mongodb://127.0.0.1:${PORT}/?replicaSet=pinus (data in data/mongo)`);
    break;
  } catch (e) {
    if (i === 59) { console.error('[mongo] could not start:', e.message); stop(); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
