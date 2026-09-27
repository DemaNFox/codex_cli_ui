#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { argon2id, hash } = requireFromServer('argon2');

const ADMIN_KEYS = [
  'CODEX_WEB_ADMIN_USERNAME',
  'CODEX_WEB_ADMIN_PASSWORD_HASH',
  'CODEX_WEB_SESSION_SECRET',
];
const ARGON2_OPTIONS = Object.freeze({
  type: argon2id,
  version: 0x13,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

function fail(message) {
  throw new Error(message);
}

export function validateAdminUsername(value) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    fail(
      'administrator username must contain 1-64 ASCII letters, digits, dot, underscore, or hyphen',
    );
  }
}

export function validatePassword(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 12 || bytes > 1024 || /^\s+$/.test(value)) {
    fail('administrator password must contain 12-1024 UTF-8 bytes and not be whitespace-only');
  }
}

function parseArguments(argv) {
  let config = '/etc/codex-web-ui/codex-web-ui.env';
  let rotate = false;
  let testInputFd;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') {
      config = argv[++index];
      if (!config) fail('--config requires a path');
    } else if (argument === '--rotate') {
      rotate = true;
    } else if (argument === '--test-input-fd') {
      const raw = argv[++index];
      if (!/^[0-9]+$/.test(raw ?? '')) fail('--test-input-fd requires a numeric descriptor');
      testInputFd = Number(raw);
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: sudo node scripts/setup-admin.mjs [--config FILE] [--rotate]\n');
      process.exit(0);
    } else {
      fail(`unknown option: ${argument}`);
    }
  }
  return { config: path.resolve(config), rotate, testInputFd };
}

function assertRoot(testInputFd) {
  if (typeof process.getuid === 'function') {
    if (process.getuid() !== 0 && testInputFd === undefined) fail('setup-admin must run as root');
    return;
  }
  if (testInputFd === undefined) {
    fail('setup-admin is supported on Linux; the descriptor input is only for automated tests');
  }
}

function assertSecureConfig(fd, configPath, testInputFd) {
  const info = fs.fstatSync(fd);
  if (!info.isFile()) fail('configuration must be a regular file');
  if (typeof process.getuid === 'function') {
    const expectedOwner = testInputFd === undefined ? 0 : process.getuid();
    if (info.uid !== expectedOwner) {
      fail(
        testInputFd === undefined
          ? 'configuration must be owned by root'
          : 'test configuration must be owned by the current user',
      );
    }
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
    fail('configuration mode must be 0600');
  }

  const pathInfo = fs.lstatSync(configPath);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    fail('configuration must be a regular non-symlink file');
  }
  if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) {
    fail('configuration changed while it was being opened');
  }
}

function openSecureConfig(configPath, testInputFd) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = fs.openSync(configPath, fsConstants.O_RDONLY | noFollow);
    assertSecureConfig(fd, configPath, testInputFd);
    return { fd, info: fs.fstatSync(fd) };
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
    if (!match || values.has(match[1])) {
      fail(`invalid or duplicate configuration assignment on line ${index + 1}`);
    }
    values.set(match[1], match[2].trim());
  }
  return { lines, values };
}

function setAdminValues(parsed, replacements) {
  const remaining = new Set(ADMIN_KEYS);
  const lines = parsed.lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  });
  if (remaining.size > 0) fail('configuration is missing required administrator settings');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function readTtyLine(ttyFd, prompt, hidden) {
  const input = fs.createReadStream(null, { fd: ttyFd, autoClose: false });
  const output = fs.createWriteStream(null, { fd: ttyFd, autoClose: false });
  const interface_ = readline.createInterface({ input, output, terminal: true });
  let echoDisabled = false;
  try {
    output.write(prompt);
    if (hidden) {
      const result = spawnSync('stty', ['-echo'], { stdio: [ttyFd, ttyFd, ttyFd] });
      if (result.status !== 0) fail('unable to disable terminal echo');
      echoDisabled = true;
    }
    return await new Promise((resolve) => interface_.once('line', resolve));
  } finally {
    if (echoDisabled) {
      spawnSync('stty', ['echo'], { stdio: [ttyFd, ttyFd, ttyFd] });
      output.write('\n');
    }
    interface_.close();
    input.destroy();
    output.destroy();
  }
}

async function readCredentials(testInputFd) {
  if (testInputFd !== undefined) {
    const input = fs.readFileSync(testInputFd, 'utf8').split(/\r?\n/);
    if (input.length < 3) fail('test input descriptor must provide username and password twice');
    return { username: input[0], password: input[1], confirmation: input[2] };
  }

  let ttyFd;
  try {
    ttyFd = fs.openSync('/dev/tty', fsConstants.O_RDWR);
  } catch {
    fail('an interactive local terminal is required');
  }
  try {
    const username = await readTtyLine(ttyFd, 'Administrator username: ', false);
    const password = await readTtyLine(ttyFd, 'Administrator password: ', true);
    const confirmation = await readTtyLine(ttyFd, 'Repeat administrator password: ', true);
    return { username, password, confirmation };
  } finally {
    fs.closeSync(ttyFd);
  }
}

function atomicWrite(configPath, contents, owner) {
  const directory = path.dirname(configPath);
  const temporary = path.join(
    directory,
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
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
    if (typeof process.getuid === 'function') fs.fchownSync(fd, owner.uid, owner.gid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, configPath);
    try {
      const directoryFd = fs.openSync(directory, fsConstants.O_RDONLY);
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  assertRoot(options.testInputFd);
  const openedConfig = openSecureConfig(options.config, options.testInputFd);
  let source;
  try {
    source = fs.readFileSync(openedConfig.fd, 'utf8');
  } finally {
    fs.closeSync(openedConfig.fd);
  }
  const parsed = parseEnvironment(source);
  if (
    !options.rotate &&
    ADMIN_KEYS.some((key) => (parsed.values.get(key) ?? '').replace(/^(['"])(.*)\1$/, '$2'))
  ) {
    fail('administrator credentials already exist; use --rotate to replace them');
  }

  const credentials = await readCredentials(options.testInputFd);
  validateAdminUsername(credentials.username);
  validatePassword(credentials.password);
  if (credentials.password !== credentials.confirmation) fail('passwords do not match');

  const passwordHash = await hash(credentials.password, {
    ...ARGON2_OPTIONS,
    salt: randomBytes(16),
  });
  const sessionSecret = randomBytes(32).toString('base64url');
  const replacements = new Map([
    ['CODEX_WEB_ADMIN_USERNAME', credentials.username],
    ['CODEX_WEB_ADMIN_PASSWORD_HASH', passwordHash],
    ['CODEX_WEB_SESSION_SECRET', sessionSecret],
  ]);
  const updated = setAdminValues(parsed, replacements);

  // Recheck the destination immediately before the atomic replacement.
  const recheckedConfig = openSecureConfig(options.config, options.testInputFd);
  try {
    if (
      recheckedConfig.info.dev !== openedConfig.info.dev ||
      recheckedConfig.info.ino !== openedConfig.info.ino
    ) {
      fail('configuration changed while credentials were being generated');
    }
    if (fs.readFileSync(recheckedConfig.fd, 'utf8') !== source) {
      fail('configuration contents changed while credentials were being generated');
    }
  } finally {
    fs.closeSync(recheckedConfig.fd);
  }
  atomicWrite(options.config, updated, openedConfig.info);
  process.stdout.write('Administrator credentials updated.\n');
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'setup failed'}\n`);
    process.exitCode = 1;
  });
}
