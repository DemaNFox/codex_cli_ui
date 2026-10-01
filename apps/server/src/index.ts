import { CodexAppServerSocketClient, CodexAppServerSupervisor } from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import { LocalAudioTranscriptionClient } from './audio-transcription.js';
import { UnixCodexUpdateBrokerClient } from './codex-update-broker.js';
import { NpmCodexVersionChecker } from './codex-version-checker.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './database.js';
import { ProjectPathPolicy } from './path-policy.js';
import { UnixProjectPathBrokerClient } from './project-path-broker.js';
import { WebPushSender } from './push-notifications.js';
import { UnixResourceBrokerClient } from './resource-broker.js';
import { buildServer } from './server.js';

const config = loadConfig();
const repository = new SqliteRepository(config.databasePath, config.eventRetentionPerThread);
const pathPolicy = await ProjectPathPolicy.create(
  config.projectRoots,
  config.projectPathBrokerSocket
    ? new UnixProjectPathBrokerClient(config.projectPathBrokerSocket)
    : undefined,
);
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
const codexVersionChecker = new NpmCodexVersionChecker();
const stopCodexVersionChecks = codexVersionChecker.startPeriodic(config.codexVersionPin);
let transcriptionClient: LocalAudioTranscriptionClient | undefined;
try {
  transcriptionClient = await LocalAudioTranscriptionClient.create({
    cachePath: config.transcriptionModelCachePath,
    model: config.transcriptionModel,
    revision: config.transcriptionModelRevision,
    language: config.transcriptionLanguage,
  });
} catch {
  console.error('Local voice transcription is unavailable because the model could not be loaded.');
}
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
  codexVersionChecker,
  ...(transcriptionClient ? { transcriptionClient } : {}),
  ...(pushSender ? { pushSender } : {}),
});

server.addHook('onClose', () => stopCodexVersionChecks());

await server.listen({ host: config.host, port: config.port });
