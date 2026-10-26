# Firefox AMO submission — 2026-10-26

Version **1.0.9** was submitted through the logged-in Mozilla Developer Hub.
The submitted Firefox file and its complete readable source archive are present.
The version page was re-read after saving release notes and confirms the source
attachment through its **View current** link.

At this verification, the status is **Awaiting Review**, with **0 errors and
0 warnings**. This records a successful submission, not approval or public
availability. Firefox desktop 142.0+ is selected; Android is not selected.
The submitted license is **Apache License 2.0**, following the reference project.

- Add-on name: 813國軍桃園總醫院新竹分院 看診進度提醒
- Gecko ID: `813-hospital-reminder@goodspeed666`
- Source commit: `1ff150e459c87ba95b9a2ef076929588fd1c78d0`
- Version ID: `6623140`
- File ID: `5167251`
- Submission timestamp shown by AMO: `2026-10-26T05:10:34Z`
- [Version management](https://addons.mozilla.org/en-US/developers/addon/813國軍桃園總醫院新竹分院-看診進度提醒/versions/6623140)
- [Status and versions](https://addons.mozilla.org/en-US/developers/addon/813國軍桃園總醫院新竹分院-看診進度提醒/versions)
- [Mozilla validation](https://addons.mozilla.org/en-US/developers/addon/813國軍桃園總醫院新竹分院-看診進度提醒/file/5167251/validation)
- [Uploaded source attachment](https://addons.mozilla.org/firefox/downloads/source/6623140)

## Uploaded artifacts

| Artifact | SHA-256 before upload |
| --- | --- |
| `artifacts/813-reminder-firefox-1.0.9.zip` | `cbced6026d9ed686cd155f2b9d07b1e5f56e4de1c26daf49bbd93af1c75d12a3` |
| `artifacts/813-reminder-firefox-1.0.9-source.zip` | `215e10397a8ec0842849b06ddb6cbb6ed221e9b1f3ab860b98f55869729d7bba` |

The package contains 15 runtime files. The source archive contains 30 readable
files, build instructions, and tests. A clean extraction reproduced both ZIP
files byte-for-byte. Local `web-ext` 10.8.0 reported zero errors, warnings, and
notices; native Firefox 158.0.1 accepted the temporary add-on. Existing Node
regressions, Firefox build/runtime tests, safe DOM tests, and the Chromium
daily-reset browser suite passed before submission.

This audit document is outside the build script's source whitelist so that
recording the external submission does not change the submitted archives.
