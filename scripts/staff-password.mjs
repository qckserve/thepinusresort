// Emergency password reset when nobody can sign in and email is not set up.
// Run on a machine with access to the database:
//   MONGODB_URI="mongodb+srv://..." node scripts/staff-password.mjs owner@example.com
// It asks for the new password (not shown on screen), sets it, unlocks the account
// and signs that person out everywhere.
import { MongoClient } from 'mongodb';
import { createInterface } from 'node:readline';
import { hashPassword } from '../server/lib/auth.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27027/?replicaSet=pinus';
if (!email) { console.error('Usage: node scripts/staff-password.mjs <email>'); process.exit(1); }

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => write(s.includes(q) ? s : '');
  return new Promise((r) => rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); r(a); }));
}

const client = await MongoClient.connect(uri);
try {
  const db = client.db(process.env.MONGODB_DB || 'thepinus');
  const user = await db.collection('staff').findOne({ email });
  if (!user) throw new Error(`No staff account for ${email}`);
  const pw = await ask(`New password for ${user.name} (${email}): `);
  if (pw.length < 10) throw new Error('Use at least 10 characters.');
  if (pw !== await ask('Type it again: ')) throw new Error('The two passwords do not match.');
  await db.collection('staff').updateOne({ _id: user._id }, { $set: { password_hash: hashPassword(pw), password_set: true, is_active: true, failed_logins: 0, locked_until: null } });
  await db.collection('sessions').deleteMany({ staff_id: user._id });
  await db.collection('audit_log').insertOne({ staff_id: null, action: 'PASSWORD_SET', summary: `${user.name}: password reset from the command line`, details: null, created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
  console.log(`Done. ${user.name} can sign in with the new password.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
