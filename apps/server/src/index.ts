import { CodexAppServerSupervisor } from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './database.js';
import { ProjectPathPolicy } from './path-policy.js';
import { buildServer } from './server.js';

const config = loadConfig();
const repository = new SqliteRepository(config.databasePath, config.eventRetentionPerThread);
const pathPolicy = await ProjectPathPolicy.create(config.projectRoots);
const appServer = new CodexAppServerSupervisor({
  executable: config.codexBinary,
  ...(config.codexHome === undefined ? {} : { codexHome: config.codexHome }),
  expectedVersion: config.codexVersionPin,
});
const attachmentStore = new AttachmentStore(config.attachmentStoragePath);
const server = await buildServer({ config, repository, pathPolicy, appServer, attachmentStore });

await server.listen({ host: config.host, port: config.port });
