# Firefox AMO build instructions

This source archive rebuilds the 813 Hospital Reminder Firefox package without
third-party dependencies. It requires Node.js 20 or newer; the release was
validated with Node.js 24.18.1 on macOS.

From the extracted source directory, run:

```sh
node scripts/build-firefox.mjs
```

The command creates:

- `dist-firefox/` — unpacked Firefox extension files for local inspection.
- `artifacts/813-reminder-firefox-1.0.9.zip` — AMO upload package; `manifest.json`
  is at the archive root.
- `artifacts/813-reminder-firefox-1.0.9-source.zip` — this readable source and
  test archive, including the build script.
- `artifacts/SHA256SUMS.txt` — SHA-256 values for both ZIP files.

The generated Firefox manifest uses the fixed add-on ID
`813-hospital-reminder@goodspeed666`, requires Firefox 142.0 or newer, and
declares no data collection. It uses a non-persistent, module background page.
The Chrome source manifest is preserved unchanged. Firefox audio is synthesized
in its background page; the build removes the explicitly marked Chrome-only
offscreen bridge from the Firefox background script, and Chrome continues to
use its original offscreen document.

To check the source copy after rebuilding, run the Node suites listed in
`test/README.md`, then verify the hashes with:

```sh
shasum -a 256 -c artifacts/SHA256SUMS.txt
```

The release package contains only the extension's runtime files. The readable
source ZIP contains the original source, extension tests, release notes, and
rebuild instructions. It excludes dependencies, generated output, user data,
and credentials. Follow `docs/firefox-amo-release.md` for the prepared AMO
listing and reviewer text.
