import { CodexAppServerSocketClient, CodexAppServerSupervisor } from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import { OpenAIAudioTranscriptionClient } from './audio-transcription.js';
import { UnixCodexUpdateBrokerClient } from './codex-update-broker.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './database.js';
import { ProjectPathPolicy } from './path-policy.js';
import { WebPushSender } from './push-notifications.js';
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
const codexUpdateBroker = new UnixCodexUpdateBrokerClient(config.codexUpdateBrokerSocket);
const transcriptionClient = config.openAiApiKey
  ? new OpenAIAudioTranscriptionClient(config.openAiApiKey, config.transcriptionModel)
  : undefined;
const pushSender = config.vapid
  ? new WebPushSender(config.vapid.publicKey, config.vapid.privateKey, config.vapid.subject)
  : undefined;
const server = await buildServer({
  config,
  repository,
  pathPolicy,
  appServer,
  attachmentStore,
  resourceBroker,
  codexUpdateBroker,
  ...(transcriptionClient ? { transcriptionClient } : {}),
  ...(pushSender ? { pushSender } : {}),
});

await server.listen({ host: config.host, port: config.port });
