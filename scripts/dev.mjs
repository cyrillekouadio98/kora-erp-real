/*
 * Lance tout l'environnement de développement en une commande, sans Docker :
 * PostgreSQL local → migrations + données de référence → API (3001) + interface (3000).
 * Ctrl+C arrête l'ensemble.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];

if (!existsSync(join(root, '.env'))) {
  copyFileSync(join(root, '.env.example'), join(root, '.env'));
  console.log('Fichier .env créé à partir de .env.example.');
}

const portOpen = (port) => new Promise((ok) => {
  const s = createConnection({ port, host: '127.0.0.1' }, () => { s.end(); ok(true); });
  s.on('error', () => ok(false));
});

function start(name, color, cmd, args, readyText) {
  return new Promise((ready) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1' } });
    children.push(p);
    const tag = `\x1b[${color}m[${name}]\x1b[0m `;
    const onData = (buf) => {
      const text = buf.toString();
      for (const line of text.split('\n')) if (line.trim()) process.stdout.write(tag + line + '\n');
      if (readyText && text.includes(readyText)) ready();
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => { if (!stopping) { console.error(`${tag}arrêté (code ${code}).`); shutdown(1); } });
    if (!readyText) ready();
  });
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children.reverse()) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (await portOpen(Number(process.env.PGPORT ?? 5432))) {
  console.log('PostgreSQL répond déjà sur le port 5432 : il est réutilisé.');
} else {
  await start('db', 36, process.execPath, [join(root, 'infra/db/dev-postgres.mjs')], 'PostgreSQL prêt');
}

for (const script of ['db:migrate', 'db:seed']) {
  const r = spawnSync(npm, ['run', '--silent', script], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`Échec de « npm run ${script} ».`); shutdown(1); }
}

await start('api', 33, npm, ['run', 'dev:api'], 'API Kora ERP prête');
await start('web', 35, npm, ['run', 'dev:web'], 'Ready');
console.log('\n  \x1b[1mKora ERP est prêt :\x1b[0m http://localhost:3000   (API : http://localhost:3001/docs)\n  Ctrl+C pour tout arrêter.\n');
