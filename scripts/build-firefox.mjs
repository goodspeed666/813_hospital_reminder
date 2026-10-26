import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = '1.0.9';
const EXTENSION_ID = '813-hospital-reminder@goodspeed666';
const GECKO_MIN_VERSION = '142.0';

const RUNTIME_FILES = [
  'background.js', 'common.js', 'options.css', 'options.html', 'options.js',
  'popup.css', 'popup.html', 'popup.js', 'shared.css', 'sound.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'
];

const SOURCE_FILES = [
  'AMO_BUILD_README.md', 'PRIVACY.md', 'README.md', 'background.js', 'common.js',
  'manifest.json', 'offscreen.html', 'offscreen.js', 'options.css', 'options.html',
  'options.js', 'popup.css', 'popup.html', 'popup.js', 'shared.css', 'sound.js',
  'docs/firefox-amo-release.md', 'icons/icon16.png', 'icons/icon32.png',
  'icons/icon48.png', 'icons/icon128.png', 'test/README.md', 'test/_helpers.mjs',
  'test/daily-reset.e2e.mjs', 'test/firefox-build.test.mjs',
  'test/firefox-runtime.test.mjs', 'test/logic.test.mjs', 'test/safe-dom.test.mjs',
  'test/options-resume-stopped.test.mjs', 'scripts/build-firefox.mjs'
].sort();

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    // Fixed ZIP time: 2000-01-01 00:00:00. This keeps rebuilds independent of
    // local file modification times.
    const dosTime = 0;
    const dosDate = ((2000 - 1980) << 9) | (1 << 5) | 1;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    centralSize += central.length;
    localOffset += local.length + compressed.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sourceEntries(projectRoot, fileNames) {
  return Promise.all(fileNames.map(async (name) => ({
    name,
    data: await readFile(path.join(projectRoot, name))
  })));
}

function removeMarkedBlock(source, beginMarker, endMarker) {
  const begin = source.indexOf(beginMarker);
  const afterBegin = begin + beginMarker.length;
  const end = source.indexOf(endMarker, afterBegin);
  if (begin < 0 || end < 0 || source.indexOf(beginMarker, afterBegin) >= 0 || source.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error(`Expected exactly one marked Firefox build block: ${beginMarker}`);
  }
  const lineStart = source.lastIndexOf('\n', begin) + 1;
  const lineEnd = source.indexOf('\n', end + endMarker.length);
  return source.slice(0, lineStart) + source.slice(lineEnd < 0 ? source.length : lineEnd + 1);
}

function firefoxBackground(source) {
  source = removeMarkedBlock(
    source,
    '// FIREFOX_BUILD: CHROME_OFFSCREEN_BRIDGE_BEGIN',
    '// FIREFOX_BUILD: CHROME_OFFSCREEN_BRIDGE_END'
  );
  return removeMarkedBlock(
    source,
    '// FIREFOX_BUILD: CHROME_OFFSCREEN_CALL_BEGIN',
    '// FIREFOX_BUILD: CHROME_OFFSCREEN_CALL_END'
  );
}

export async function buildFirefox({ projectRoot = PROJECT_ROOT, outputRoot = PROJECT_ROOT } = {}) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
  if (manifest.version !== VERSION) throw new Error(`Expected source manifest version ${VERSION}`);
  delete manifest.minimum_chrome_version;
  manifest.permissions = (manifest.permissions || []).filter((permission) => permission !== 'offscreen');
  manifest.background = { scripts: ['background.js'], type: 'module', persistent: false };
  manifest.browser_specific_settings = {
    ...(manifest.browser_specific_settings || {}),
    gecko: {
      id: EXTENSION_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: { required: ['none'] }
    }
  };

  const distDir = path.join(outputRoot, 'dist-firefox');
  const artifactsDir = path.join(outputRoot, 'artifacts');
  const packagePath = path.join(artifactsDir, `813-reminder-firefox-${VERSION}.zip`);
  const sourcePath = path.join(artifactsDir, `813-reminder-firefox-${VERSION}-source.zip`);
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  for (const name of RUNTIME_FILES) {
    const destination = path.join(distDir, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(projectRoot, name), destination);
    if (name === 'background.js') {
      await writeFile(destination, firefoxBackground(await readFile(destination, 'utf8')));
    }
  }
  await writeFile(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const runtimeEntries = await sourceEntries(distDir, ['manifest.json', ...RUNTIME_FILES]);
  const packageBuffer = zipBuffer(runtimeEntries);
  const sourceBuffer = zipBuffer(await sourceEntries(projectRoot, SOURCE_FILES));
  await writeFile(packagePath, packageBuffer);
  await writeFile(sourcePath, sourceBuffer);

  const packageSha256 = sha256(packageBuffer);
  const sourceSha256 = sha256(sourceBuffer);
  await writeFile(
    path.join(artifactsDir, 'SHA256SUMS.txt'),
    `${packageSha256}  artifacts/${path.basename(packagePath)}\n${sourceSha256}  artifacts/${path.basename(sourcePath)}\n`
  );
  return { distDir, packagePath, sourcePath, packageSha256, sourceSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildFirefox();
  console.log(`Firefox package: ${result.packagePath}`);
  console.log(`  SHA-256 ${result.packageSha256}`);
  console.log(`Readable sources: ${result.sourcePath}`);
  console.log(`  SHA-256 ${result.sourceSha256}`);
}
