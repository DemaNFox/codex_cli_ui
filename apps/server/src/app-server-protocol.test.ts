import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALLOWED_REQUESTS } from './app-server.js';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('protocol/manifest.json', root), 'utf8')) as {
  codexCliVersion: string;
  files: Record<string, string>;
};
const toolchain = readFileSync(new URL('infra/toolchain.env', root), 'utf8');
const protocolPath = `protocol/${manifest.codexCliVersion}/codex_app_server_protocol.v2.schemas.json`;
const protocolBytes = readFileSync(new URL(protocolPath, root));
const protocol = JSON.parse(protocolBytes.toString('utf8')) as {
  definitions: {
    ClientRequest: {
      oneOf: Array<{ properties?: { method?: { enum?: string[] } } }>;
    };
  };
};

describe('reviewed Codex protocol parity', () => {
  it('matches the pinned runtime and immutable protocol digest', () => {
    expect(toolchain).toMatch(
      new RegExp(`^CODEX_CLI_VERSION=${manifest.codexCliVersion.replaceAll('.', '\\.')}\\r?$`, 'm'),
    );
    expect(createHash('sha256').update(protocolBytes).digest('hex')).toBe(
      manifest.files[`${manifest.codexCliVersion}/codex_app_server_protocol.v2.schemas.json`],
    );
  });

  it('keeps every server RPC, including paginated history, in the reviewed schema', () => {
    const methods = new Set(
      protocol.definitions.ClientRequest.oneOf.flatMap(
        (entry) => entry.properties?.method?.enum ?? [],
      ),
    );
    expect([...ALLOWED_REQUESTS].filter((method) => !methods.has(method))).toEqual([]);
    expect(ALLOWED_REQUESTS.has('thread/turns/list')).toBe(true);
  });
});
