// Local IM bot credentials for `concord host` (personal mode). Each user stores
// THEIR OWN custom-app creds (never an org-wide central token) at ~/.concord/
// creds.json with 0600 perms — the whole point of personal mode is the token only
// ever lives on the user's machine. Pure-ish (file I/O); root injectable for tests.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const defaultRoot = () => process.env.CONCORD_HOME || join(homedir(), '.concord');
export const credsPath = (root = defaultRoot()) => join(root, 'creds.json');

export function loadCreds(root = defaultRoot()) {
  const f = credsPath(root);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

function write(all, root) {
  const f = credsPath(root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(all, null, 2), { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* best effort: lock down even a pre-existing file */ }
}

// platform: 'lark'|'feishu'; data: { appId, appSecret, domain }
export function saveCreds(platform, data, root = defaultRoot()) {
  const all = loadCreds(root);
  all[platform] = { ...data, savedAt: new Date().toISOString() };
  write(all, root);
  return all;
}
export function getCreds(platform, root = defaultRoot()) { return loadCreds(root)[platform] || null; }
export function removeCreds(platform, root = defaultRoot()) {
  const all = loadCreds(root);
  const had = !!all[platform];
  delete all[platform];
  write(all, root);
  return had;
}
