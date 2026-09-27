import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verify } from '../../apps/server/node_modules/argon2/argon2.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/setup-admin.mjs');

function environmentFile(directory, populated = false) {
  const target = path.join(directory, 'codex-web-ui.env');
  fs.writeFileSync(
    target,
    [
      'CODEX_WEB_HOST=127.0.0.1',
      `CODEX_WEB_ADMIN_USERNAME=${populated ? 'existing' : ''}`,
      `CODEX_WEB_ADMIN_PASSWORD_HASH=${populated ? '$argon2id$existing' : ''}`,
      `CODEX_WEB_SESSION_SECRET=${populated ? 'existing-secret' : ''}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  fs.chmodSync(target, 0o600);
  return target;
}

function runSetup(target, input, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--config', target, '--test-input-fd', '0', ...extra],
    { cwd: ROOT, input, encoding: 'utf8' },
  );
}

function readAssignments(target) {
  return new Map(
    fs
      .readFileSync(target, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s, 2)),
  );
}

test('writes bounded Argon2id credentials atomically without disclosing plaintext', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admin-'));
  const target = environmentFile(directory);
  const originalOwner = fs.statSync(target);
  const password = 'Correct horse battery staple 42';
  const result = runSetup(target, `owner\n${password}\n${password}\n`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Administrator credentials updated.\n');
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stderr.includes(password), false);
  const values = readAssignments(target);
  assert.equal(values.get('CODEX_WEB_ADMIN_USERNAME'), 'owner');
  assert.match(
    values.get('CODEX_WEB_ADMIN_PASSWORD_HASH'),
    /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
  );
  assert.equal(await verify(values.get('CODEX_WEB_ADMIN_PASSWORD_HASH'), password), true);
  assert.match(values.get('CODEX_WEB_SESSION_SECRET'), /^[A-Za-z0-9_-]{43}$/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(target).uid, originalOwner.uid);
    assert.equal(fs.statSync(target).gid, originalOwner.gid);
  }
});

test('rejects a confirmation mismatch without changing the file or printing plaintext', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admin-'));
  const target = environmentFile(directory);
  const original = fs.readFileSync(target, 'utf8');
  const password = 'Never print this password';
  const result = runSetup(target, `owner\n${password}\ndifferent password\n`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /passwords do not match/);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stderr.includes(password), false);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('refuses implicit overwrite and permits explicit rotation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admin-'));
  const target = environmentFile(directory, true);
  const input = 'owner\nA replacement password 42\nA replacement password 42\n';
  const refused = runSetup(target, input);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /use --rotate/);

  const rotated = runSetup(target, input, ['--rotate']);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(readAssignments(target).get('CODEX_WEB_ADMIN_USERNAME'), 'owner');
});

test('rejects weak passwords, malformed usernames, symlinks, and permissive files', () => {
  for (const [username, password, expected] of [
    ['bad name', 'A sufficiently long password', /username/],
    ['owner', 'too-short', /12-1024/],
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admin-'));
    const target = environmentFile(directory);
    const result = runSetup(target, `${username}\n${password}\n${password}\n`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admin-'));
  const target = environmentFile(directory);
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o644);
    const permissive = runSetup(
      target,
      'owner\nA sufficiently long password\nA sufficiently long password\n',
    );
    assert.notEqual(permissive.status, 0);
    assert.match(permissive.stderr, /0600/);

    fs.chmodSync(target, 0o600);
    const link = path.join(directory, 'linked.env');
    fs.symlinkSync(target, link);
    const linked = runSetup(
      link,
      'owner\nA sufficiently long password\nA sufficiently long password\n',
    );
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /configuration/);
  }
});

function runHashValidator(value) {
  const validator = fs.readFileSync(path.join(ROOT, 'scripts/validate-config.sh'), 'utf8');
  const python = validator.split("<<'PY'\n", 2)[1].replace(/\nPY\s*$/, '\n');
  return spawnSync('python', ['-c', python, '--check-admin-hash', value], {
    encoding: 'utf8',
  });
}

test('validator accepts the canonical hash and rejects malformed, weak, and extreme hashes', () => {
  const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
  const digest = Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '');
  const phc = (parameters, usedSalt = salt, usedDigest = digest) =>
    `$argon2id$v=19$${parameters}$${usedSalt}$${usedDigest}`;

  assert.equal(runHashValidator(phc('m=65536,t=3,p=1')).status, 0);
  for (const invalid of [
    '$argon2id$malformed',
    phc('m=32768,t=3,p=1'),
    phc('m=262145,t=3,p=1'),
    phc('m=65536,t=2,p=1'),
    phc('m=65536,t=7,p=1'),
    phc('m=65536,t=3,p=0'),
    phc('m=65536,t=3,p=5'),
    phc('m=65536,t=3,p=1', Buffer.alloc(15, 1).toString('base64').replace(/=+$/, '')),
    phc('m=65536,t=3,p=1', salt, Buffer.alloc(65, 2).toString('base64').replace(/=+$/, '')),
    phc('m=65536,t=3,p=1').replace('$v=19$', '$v=16$'),
  ]) {
    const result = runHashValidator(invalid);
    assert.notEqual(result.status, 0, `unexpectedly accepted ${invalid.slice(0, 40)}`);
  }
});
