import { CodexAppServerSocketClient, CodexAppServerSupervisor } from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import { OpenAIAudioTranscriptionClient } from './audio-transcription.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './database.js';
import { ProjectPathPolicy } from './path-policy.js';
import { UnixResourceBrokerClient } from './resource-broker.js';
import { buildServer } from './server.js';

const config = loadConfig();
const repository = new SqliteRepository(config.databasePath, config.eventRetentionPerThread);
const pathPolicy = await ProjectPathPolicy.create(config.projectRoots);
const appServer = config.appServerSocket
  ? new CodexAppServerSocketClient({ socketPath: config.appServerSocket })
  : new CodexAppServerSupervisor({
      executable: config.codexBinary,
      ...(config.codexHome === undefined ? {} : { codexHome: config.codexHome }),
      expectedVersion: config.codexVersionPin,
    });
const attachmentStore = new AttachmentStore(config.attachmentStoragePath);
const resourceBroker = new UnixResourceBrokerClient(config.resourceBrokerSocket);
const transcriptionClient = config.openAiApiKey
  ? new OpenAIAudioTranscriptionClient(config.openAiApiKey, config.transcriptionModel)
  : undefined;
const server = await buildServer({
  config,
  repository,
  pathPolicy,
  appServer,
  attachmentStore,
  resourceBroker,
  ...(transcriptionClient ? { transcriptionClient } : {}),
});

await server.listen({ host: config.host, port: config.port });
