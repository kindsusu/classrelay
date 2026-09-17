import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Output is deliberately ignored by Git. No credentials are printed.
const [backendUrl = 'http://127.0.0.1:8787', countText = '30'] = process.argv.slice(2);
const count = Number(countText);
const url = new URL(backendUrl);
if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
  throw new Error('Use HTTPS, or localhost HTTP for development.');
}
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Device count must be 1..100');
const out = resolve('provisioned');
await mkdir(out, { recursive: true });
const token = () => randomBytes(32).toString('base64url');
const controller = token();
const agents = {};
const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
// Refuse overwriting an existing controller to prevent accidental token rotation.
await save('controller.local.json', { role: 'controller', backendUrl: url.origin, token: controller, deviceId: 'controller' });
for (let i = 1; i <= count; i++) {
  const deviceId = `student-${String(i).padStart(2, '0')}`;
  agents[deviceId] = token();
  await save(`${deviceId}.local.json`, { role: 'agent', backendUrl: url.origin, token: agents[deviceId], deviceId, autoLaunch: false, nativeInputLock: false });
}
await writeFile(resolve(out, 'backend-secrets.local.json'), JSON.stringify({ CONTROLLER_TOKEN: controller, AGENT_TOKENS_JSON: JSON.stringify(agents) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created ${count} student configs and controller/backend files in provisioned/. Protect these files with Windows ACLs.`);
