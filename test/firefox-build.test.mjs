import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildFirefox } from '../scripts/build-firefox.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputRoot = await mkdtemp(path.join(tmpdir(), '813-firefox-build-'));

async function zipEntries(file) {
  const buffer = await readFile(file);
  let endOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { endOffset = i; break; }
  }
  assert.notEqual(endOffset, -1, `${file} has a ZIP end record`);
  const count = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `${file} has a valid central directory`);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipNames(file) {
  return (await zipEntries(file)).map((entry) => entry.name);
}

async function extractZip(file, destination) {
  for (const entry of await zipEntries(file)) {
    const output = path.join(destination, entry.name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, entry.data);
  }
}

try {
  const result = await buildFirefox({ projectRoot, outputRoot });
  const manifest = JSON.parse(await readFile(path.join(outputRoot, 'dist-firefox', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.9');
  assert.deepEqual(manifest.background, {
    scripts: ['background.js'],
    type: 'module',
    persistent: false
  });
  assert.deepEqual(manifest.browser_specific_settings.gecko, {
    id: '813-hospital-reminder@goodspeed666',
    strict_min_version: '142.0',
    data_collection_permissions: { required: ['none'] }
  });
  assert.equal('minimum_chrome_version' in manifest, false);
  assert.equal(manifest.permissions.includes('offscreen'), false);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'notifications']);
  const firefoxBackground = await readFile(path.join(outputRoot, 'dist-firefox', 'background.js'), 'utf8');
  assert.equal(/chrome\.offscreen\.(?:hasDocument|createDocument)|ensureOffscreen/.test(firefoxBackground), false,
    'Firefox background contains no Chrome-only offscreen bridge');

  const runtimeFiles = (await readdir(path.join(outputRoot, 'dist-firefox'), { recursive: true }))
    .map((entry) => entry.replaceAll(path.sep, '/')).sort();
  assert.deepEqual(runtimeFiles, [
    'background.js', 'common.js', 'icons', 'icons/icon128.png', 'icons/icon16.png',
    'icons/icon32.png', 'icons/icon48.png', 'manifest.json', 'options.css', 'options.html',
    'options.js', 'popup.css', 'popup.html', 'popup.js', 'shared.css', 'sound.js'
  ]);
  const packageNames = await zipNames(result.packagePath);
  assert.deepEqual(packageNames, runtimeFiles.filter((entry) => entry !== 'icons'));
  assert.ok(packageNames.includes('manifest.json'), 'Firefox package has manifest at archive root');
  assert.equal(packageNames.some((name) => /(^|\/)(test|pwa|webstore|node_modules)(\/|$)/.test(name)), false);

  const sourceNames = await zipNames(result.sourcePath);
  for (const name of [
    'AMO_BUILD_README.md', 'README.md', 'PRIVACY.md', 'manifest.json', 'background.js',
    'common.js', 'sound.js', 'offscreen.js', 'options.js', 'popup.js',
    'scripts/build-firefox.mjs', 'docs/firefox-amo-release.md',
    'test/logic.test.mjs', 'test/firefox-runtime.test.mjs', 'test/firefox-build.test.mjs'
  ]) assert.ok(sourceNames.includes(name), `source archive contains ${name}`);
  assert.equal(sourceNames.some((name) => /(^|\/)(node_modules|dist-firefox|artifacts)(\/|$)/.test(name)), false);

  const extractedSource = path.join(outputRoot, 'source-extracted');
  await extractZip(result.sourcePath, extractedSource);
  const cleanBuild = spawnSync(process.execPath, ['scripts/build-firefox.mjs'], {
    cwd: extractedSource,
    encoding: 'utf8'
  });
  assert.equal(cleanBuild.status, 0, cleanBuild.stderr || cleanBuild.error?.message);
  const cleanSums = await readFile(path.join(extractedSource, 'artifacts', 'SHA256SUMS.txt'), 'utf8');
  assert.ok(cleanSums.includes(`${result.packageSha256}  artifacts/813-reminder-firefox-1.0.9.zip`));
  assert.ok(cleanSums.includes(`${result.sourceSha256}  artifacts/813-reminder-firefox-1.0.9-source.zip`));

  const firstPackageHash = result.packageSha256;
  const firstSourceHash = result.sourceSha256;
  const checkedHashes = spawnSync('shasum', ['-a', '256', '-c', 'artifacts/SHA256SUMS.txt'], {
    cwd: outputRoot,
    encoding: 'utf8'
  });
  assert.equal(checkedHashes.status, 0, checkedHashes.stdout + checkedHashes.stderr);
  const rebuilt = await buildFirefox({ projectRoot, outputRoot });
  assert.equal(rebuilt.packageSha256, firstPackageHash, 'package ZIP is reproducible');
  assert.equal(rebuilt.sourceSha256, firstSourceHash, 'source ZIP is reproducible');
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

console.log('Firefox package contents and reproducibility pass ✅');
