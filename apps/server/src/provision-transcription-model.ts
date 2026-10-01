import path from 'node:path';

import { env, pipeline } from '@huggingface/transformers';

import {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL_REVISION,
  writeLocalModelManifest,
} from './audio-transcription.js';

const TRUSTED_DEFAULT_MODEL_FILES = [
  {
    path: 'config.json',
    bytes: 2_243,
    sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
  },
  {
    path: 'generation_config.json',
    bytes: 3_832,
    sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
  },
  {
    path: 'onnx/decoder_model_merged_quantized.onnx',
    bytes: 53_693_315,
    sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
  },
  {
    path: 'onnx/encoder_model_quantized.onnx',
    bytes: 23_201_314,
    sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
  },
  {
    path: 'preprocessor_config.json',
    bytes: 339,
    sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  },
  {
    path: 'tokenizer.json',
    bytes: 2_480_466,
    sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 282_682,
    sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
  },
] as const;

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const cachePath = path.resolve(option('--cache'));
const model = option('--model', DEFAULT_TRANSCRIPTION_MODEL);
const revision = option('--revision', DEFAULT_TRANSCRIPTION_MODEL_REVISION);
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u.test(model) || model.includes('..'))
  throw new Error('Invalid transcription model id');
if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Invalid transcription model revision');

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = cachePath;

const transcriber = await pipeline('automatic-speech-recognition', model, {
  revision,
  cache_dir: cachePath,
  dtype: 'q8',
  device: 'cpu',
});
await transcriber.dispose();
await writeLocalModelManifest({
  cachePath,
  model,
  revision,
  ...(model === DEFAULT_TRANSCRIPTION_MODEL && revision === DEFAULT_TRANSCRIPTION_MODEL_REVISION
    ? { expectedFiles: TRUSTED_DEFAULT_MODEL_FILES }
    : {}),
});
console.log(`Provisioned pinned local transcription model ${model}@${revision.slice(0, 12)}.`);
