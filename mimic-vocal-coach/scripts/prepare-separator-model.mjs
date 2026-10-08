#!/usr/bin/env node
// Puts the vocal-isolation model where the app looks for it and writes its manifest.
//
//   node scripts/prepare-separator-model.mjs --from /path/to/spleeter2_vocals_ratio_int8mix.onnx
//   node scripts/prepare-separator-model.mjs --from-url <https url>   download the model (for example a GitHub release asset) and keep it only
//                                                              if its size and SHA-256 match the COMMITTED manifest; the manifest is not changed
//   node scripts/prepare-separator-model.mjs --check          verify public/models against its manifest, change nothing
//
// public/models/vocal-isolation.onnx is NOT committed (it is about 20 MB; .gitignore lists it). The manifest next to it,
// public/models/vocal-isolation.json, IS committed: the app asks for the manifest first and only offers "Isolate the vocal" when the
// site carries it and the model it describes. The manifest holds the file's real size and SHA-256, which the app checks after the
// download, so a damaged or swapped file is never used.
//
// Options:  --from <file>   the converted ONNX model (or set MIMIC_SEPARATOR_ONNX)
//           --from-url <u>  fetch the model from an https URL and verify it against the committed manifest (a fresh checkout on another machine)
//           --name <text>   --version <text>   --licence <text>   --source <text>   override the manifest text
//           --check         verify only
// Exit code 0 on success, 1 on a problem (the message says which).

import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'models');
const modelPath = join(modelsDir, 'vocal-isolation.onnx');
const manifestPath = join(modelsDir, 'vocal-isolation.json');

const DEFAULTS = {
  name: 'Spleeter 2-stems, vocals (ratio mask, int8 weights)',
  version: '2stems-int8mix-1',
  licence:
    'Spleeter by Deezer. The code is MIT-licensed (Copyright (c) 2019-present Deezer SA). Deezer states no separate licence for the pretrained weights; confirm before a public release.',
  source: 'https://github.com/deezer/spleeter (pretrained 2stems model, converted to ONNX with int8 weight storage)',
  inputRate: 44100,
};

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (['--from', '--from-url', '--name', '--version', '--licence', '--source'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

function sha256Of(file) {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolveHash(h.digest('hex')));
  });
}

async function check() {
  if (!existsSync(manifestPath)) throw new Error(`No manifest at ${manifestPath}. Run this script with --from <model.onnx> first.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!existsSync(modelPath)) throw new Error(`The manifest is there but ${modelPath} is not (the model is not committed; copy it in with --from).`);
  const bytes = statSync(modelPath).size;
  const sha256 = await sha256Of(modelPath);
  if (bytes !== manifest.bytes) throw new Error(`Size differs: file ${bytes}, manifest ${manifest.bytes}.`);
  if (sha256 !== manifest.sha256) throw new Error(`SHA-256 differs: file ${sha256}, manifest ${manifest.sha256}.`);
  console.log(`OK  ${manifest.name} ${manifest.version}  ${bytes} bytes  sha256 ${sha256}`);
}

/** Download the model and keep it only if it is the file the committed manifest describes (size and SHA-256). */
async function fromUrl(url) {
  if (!/^https:\/\//i.test(url)) throw new Error('--from-url needs an https:// address.');
  if (!existsSync(manifestPath)) throw new Error(`No committed manifest at ${manifestPath}; there is nothing to verify the download against.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`The download answered ${res.status} ${res.statusText}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== manifest.bytes) throw new Error(`The download is ${bytes.length} bytes, the manifest says ${manifest.bytes}. Nothing was kept.`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.sha256) throw new Error(`The download's SHA-256 is ${digest}, the manifest says ${manifest.sha256}. Nothing was kept.`);
  mkdirSync(modelsDir, { recursive: true });
  const partial = `${modelPath}.part`;
  try {
    writeFileSync(partial, bytes);
    renameSync(partial, modelPath);
  } finally {
    rmSync(partial, { force: true });
  }
  console.log(`OK  ${manifest.name} ${manifest.version}  ${bytes.length} bytes  sha256 ${digest}`);
  console.log(`  -> ${modelPath}  (git-ignored; the manifest is unchanged)`);
}

async function prepare(args) {
  const from = args.from ?? process.env.MIMIC_SEPARATOR_ONNX;
  if (!from) throw new Error('Say where the converted model is: --from <file.onnx> (or set MIMIC_SEPARATOR_ONNX).');
  if (!existsSync(from)) throw new Error(`Model file not found: ${from}`);
  const bytes = statSync(from).size;
  if (bytes < 1_000_000 || bytes > 160 * 1024 * 1024) throw new Error(`Unexpected model size ${bytes} bytes; refusing.`);
  mkdirSync(modelsDir, { recursive: true });
  copyFileSync(from, modelPath);
  const sha256 = await sha256Of(modelPath);
  const manifest = {
    name: args.name ?? DEFAULTS.name,
    version: args.version ?? DEFAULTS.version,
    bytes,
    sha256,
    licence: args.licence ?? DEFAULTS.licence,
    source: args.source ?? DEFAULTS.source,
    inputRate: DEFAULTS.inputRate,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Copied ${from}`);
  console.log(`  -> ${modelPath}  (${bytes} bytes, git-ignored)`);
  console.log(`  -> ${manifestPath}  (commit this one)`);
  console.log(`sha256 ${sha256}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) await check();
  else if (args['from-url']) await fromUrl(args['from-url']);
  else await prepare(args);
} catch (err) {
  console.error(`prepare-separator-model: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
