#!/usr/bin/env node

import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { generateVAPIDKeys } = requireFromServer('web-push');
const PUSH_KEYS = [
  'CODEX_WEB_VAPID_PUBLIC_KEY',
  'CODEX_WEB_VAPID_PRIVATE_KEY',
  'CODEX_WEB_VAPID_SUBJECT',
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let config = '/etc/codex-web-ui/codex-web-ui.env';
  let testMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') {
      config = argv[++index];
      if (!config) fail('--config requires a path');
    } else if (argument === '--test-mode') {
      testMode = true;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: sudo node scripts/setup-push.mjs [--config FILE]\n');
      process.exit(0);
    } else {
      fail(`unknown option: ${argument}`);
    }
  }
  return { config: path.resolve(config), testMode };
}

function openSecureConfig(configPath, testMode) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !testMode)
    fail('setup-push must run as root');
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = fs.openSync(configPath, fsConstants.O_RDONLY | noFollow);
    const info = fs.fstatSync(fd);
    const pathInfo = fs.lstatSync(configPath);
    if (!info.isFile() || pathInfo.isSymbolicLink() || !pathInfo.isFile())
      fail('configuration must be a regular non-symlink file');
    if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino)
      fail('configuration changed while it was being opened');
    if (typeof process.getuid === 'function') {
      const expectedOwner = testMode ? process.getuid() : 0;
      if (info.uid !== expectedOwner) fail('configuration has an unexpected owner');
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600)
      fail('configuration mode must be 0600');
    return { fd, info };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof Error && error.message.startsWith('configuration')) throw error;
    fail('configuration must already exist and be securely readable');
  }
}

function parseEnvironment(source) {
  const values = new Map();
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || values.has(match[1]))
      fail(`invalid or duplicate assignment on line ${index + 1}`);
    values.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return { lines, values };
}

function validateExisting(values) {
  const present = PUSH_KEYS.filter((key) => values.get(key));
  if (present.length === 0) return false;
  if (present.length !== PUSH_KEYS.length) fail('VAPID settings must be either complete or empty');
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(values.get(PUSH_KEYS[0]))) fail('invalid VAPID public key');
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(values.get(PUSH_KEYS[1]))) fail('invalid VAPID private key');
  if (!/^(mailto:.+@.+|https:\/\/[^\s]+)$/.test(values.get(PUSH_KEYS[2])))
    fail('invalid VAPID subject');
  return true;
}

function setValues(parsed, replacements) {
  const remaining = new Set(PUSH_KEYS);
  const lines = parsed.lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  });
  if (remaining.size > 0) {
    lines.push('', '# Browser Push credentials generated locally; keep the private key secret.');
    for (const key of PUSH_KEYS)
      if (remaining.has(key)) lines.push(`${key}=${replacements.get(key)}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function atomicWrite(configPath, contents, owner) {
  const temporary = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fchmodSync(fd, 0o600);
    if (typeof process.getuid === 'function') fs.fchownSync(fd, owner.uid, owner.gid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, configPath);
    try {
      const directoryFd = fs.openSync(path.dirname(configPath), fsConstants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some filesystems do not support syncing directory handles.
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const opened = openSecureConfig(options.config, options.testMode);
  let source;
  try {
    source = fs.readFileSync(opened.fd, 'utf8');
  } finally {
    fs.closeSync(opened.fd);
  }
  const parsed = parseEnvironment(source);
  if (validateExisting(parsed.values)) {
    process.stdout.write('Browser Push credentials already configured.\n');
    return;
  }
  const origin = parsed.values.get('CODEX_WEB_PUBLIC_ORIGIN');
  if (!origin || !/^https:\/\/[^/]+(?::[0-9]+)?$/.test(origin))
    fail('CODEX_WEB_PUBLIC_ORIGIN must be one HTTPS origin before generating VAPID credentials');
  const generated = generateVAPIDKeys();
  const replacements = new Map([
    ['CODEX_WEB_VAPID_PUBLIC_KEY', generated.publicKey],
    ['CODEX_WEB_VAPID_PRIVATE_KEY', generated.privateKey],
    ['CODEX_WEB_VAPID_SUBJECT', origin],
  ]);
  const updated = setValues(parsed, replacements);
  const rechecked = openSecureConfig(options.config, options.testMode);
  try {
    if (rechecked.info.dev !== opened.info.dev || rechecked.info.ino !== opened.info.ino)
      fail('configuration changed while credentials were being generated');
    if (fs.readFileSync(rechecked.fd, 'utf8') !== source)
      fail('configuration contents changed while credentials were being generated');
  } finally {
    fs.closeSync(rechecked.fd);
  }
  atomicWrite(options.config, updated, opened.info);
  process.stdout.write('Browser Push credentials configured.\n');
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'setup failed'}\n`);
    process.exitCode = 1;
  }
}
