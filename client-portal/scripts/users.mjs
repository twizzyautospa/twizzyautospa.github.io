// Manage portal logins (stored hashed in the PORTAL_USERS env var on Netlify).
//   node scripts/users.mjs list
//   node scripts/users.mjs add <username> "<Client Name>" <ghlPipelineId>
//   node scripts/users.mjs add-admin <username> "<Name>"
//   node scripts/users.mjs reset <username>
//   node scripts/users.mjs set <username> '<password>'
//   node scripts/users.mjs remove <username>
// Then run: node scripts/deploy.mjs   (functions read env vars at deploy time)
// New passwords are printed once. Only the hash is stored.
import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { getEnv, setEnv } from './netlify.mjs';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
export function newPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

const [cmd, ...args] = process.argv.slice(2);
const users = JSON.parse((await getEnv('PORTAL_USERS')) || '[]');
const find = (u) => users.find((x) => x.u === String(u || '').toLowerCase());
const save = async () => { await setEnv('PORTAL_USERS', JSON.stringify(users)); console.log('Saved. Now run: node scripts/deploy.mjs'); };

if (cmd === 'list' || !cmd) {
  for (const x of users) console.log(`${x.u.padEnd(20)} ${x.admin ? '(admin)' : x.p.padEnd(22)} ${x.n}`);
} else if (cmd === 'add' || cmd === 'add-admin') {
  const [u, n, p] = args;
  if (!u || !n || (cmd === 'add' && !p)) throw new Error('Usage: add <username> "<Client Name>" <pipelineId>');
  if (find(u)) throw new Error(`${u} already exists`);
  const pw = newPassword();
  users.push({ u: u.toLowerCase(), n, ...(cmd === 'add' ? { p } : { admin: true }), h: hashPassword(pw) });
  await save();
  console.log(`${u}  password: ${pw}`);
} else if (cmd === 'reset') {
  const x = find(args[0]);
  if (!x) throw new Error(`No user ${args[0]}`);
  const pw = newPassword();
  x.h = hashPassword(pw);
  await save();
  console.log(`${x.u}  new password: ${pw}`);
} else if (cmd === 'set') {
  const [u, pw] = args;
  const x = find(u);
  if (!x) throw new Error(`No user ${u}`);
  if (!pw || pw.length < 6) throw new Error('Password must be at least 6 characters');
  x.h = hashPassword(pw);
  await save();
  console.log(`${x.u}  password set`);
} else if (cmd === 'remove') {
  const i = users.findIndex((x) => x.u === String(args[0] || '').toLowerCase());
  if (i < 0) throw new Error(`No user ${args[0]}`);
  users.splice(i, 1);
  await save();
} else {
  throw new Error(`Unknown command ${cmd}`);
}
