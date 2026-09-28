import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/setup-push.mjs');

function fixture(lines = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-push-'));
  const target = path.join(directory, 'codex-web-ui.env');
  fs.writeFileSync(
    target,
    ['CODEX_WEB_PUBLIC_ORIGIN=https://codex.example.test', ...lines, ''].join('\n'),
    { mode: 0o600 },
  );
  fs.chmodSync(target, 0o600);
  return target;
}

function run(target) {
  return spawnSync(process.execPath, [SCRIPT, '--config', target, '--test-mode'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function assignments(target) {
  return new Map(
    fs
      .readFileSync(target, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/=(.*)/s, 2)),
  );
}

test('generates VAPID credentials without printing either key and is idempotent', () => {
  const target = fixture([
    'CODEX_WEB_VAPID_PUBLIC_KEY=',
    'CODEX_WEB_VAPID_PRIVATE_KEY=',
    'CODEX_WEB_VAPID_SUBJECT=',
  ]);
  const first = run(target);
  assert.equal(first.status, 0, first.stderr);
  const values = assignments(target);
  assert.match(values.get('CODEX_WEB_VAPID_PUBLIC_KEY'), /^[A-Za-z0-9_-]{80,120}$/);
  assert.match(values.get('CODEX_WEB_VAPID_PRIVATE_KEY'), /^[A-Za-z0-9_-]{40,80}$/);
  assert.equal(values.get('CODEX_WEB_VAPID_SUBJECT'), 'https://codex.example.test');
  assert.equal(first.stdout.includes(values.get('CODEX_WEB_VAPID_PUBLIC_KEY')), false);
  assert.equal(first.stdout.includes(values.get('CODEX_WEB_VAPID_PRIVATE_KEY')), false);

  const before = fs.readFileSync(target, 'utf8');
  const second = run(target);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('appends missing settings for an existing installation and rejects partial credentials', () => {
  const legacy = fixture();
  assert.equal(run(legacy).status, 0);
  assert.equal(assignments(legacy).has('CODEX_WEB_VAPID_PRIVATE_KEY'), true);

  const partial = fixture(['CODEX_WEB_VAPID_PUBLIC_KEY=AAAA']);
  const result = run(partial);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /complete or empty/);
});

test('rejects insecure origins, symlinks and permissive files', () => {
  const insecure = fixture();
  fs.writeFileSync(insecure, 'CODEX_WEB_PUBLIC_ORIGIN=http://example.test\n', { mode: 0o600 });
  assert.notEqual(run(insecure).status, 0);

  if (process.platform !== 'win32') {
    const permissive = fixture();
    fs.chmodSync(permissive, 0o644);
    assert.notEqual(run(permissive).status, 0);
    fs.chmodSync(permissive, 0o600);
    const linked = `${permissive}.link`;
    fs.symlinkSync(permissive, linked);
    assert.notEqual(run(linked).status, 0);
  }
});
