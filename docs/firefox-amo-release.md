# Firefox AMO release — 1.0.9

Prepared release package for Firefox desktop. This document contains the
listing copy and reviewer notes to use in Mozilla Developer Hub. It does not
record a submission or approval; record those states only after verifying them
in Developer Hub and on the public listing.

## Compatibility

- Firefox desktop 142.0 and newer.
- Android compatibility is not selected for this release.
- Fixed Gecko ID: `813-hospital-reminder@goodspeed666`.
- Data collection declaration: none.
- Chrome remains on the source manifest and keeps its service worker and
  offscreen audio permission.

## Listing metadata

- **Name:** 813國軍桃園總醫院新竹分院 看診進度提醒
- **Summary:** 自動查詢 813 國軍桃園總醫院新竹分院看診進度，診間叫號異動或快輪到你時通知。
- **Description:**

  【非官方】自動查詢國軍桃園總醫院新竹分院公開的當日看診進度。選擇診間並輸入看診號碼後，進度改變、快輪到你或輪到你時會顯示通知；也可在工具列面板查看目前進度。

  設定與當日進度只保存在瀏覽器本機。擴充功能只會向醫院公開的看診進度 API 發出固定查詢，不會傳送你的號碼或設定，也沒有追蹤或分析工具。

  本工具由個人開發，非醫院官方推出，也未經醫院授權或背書。看診進度以院方現場公告為準。
- **Privacy policy:** `PRIVACY.md` at the project GitHub repository.
- **Release notes:** Firefox desktop compatibility, Firefox-supported notifications, and reminder tones without the Chrome-only offscreen permission. Existing stop-after-passing-number behavior is retained.

## Reviewer notes

This is an unofficial, personal utility that reads the hospital's public,
same-day clinic progress API. It does not collect account, identity, or health
records and has no telemetry, analytics, advertising, or developer-operated
server. The only request is a fixed GET to the public hospital API; it does not
include the user's clinic selection, configured number, or other extension
settings.

The `storage` permission keeps clinic selections, a user-entered visit number,
notification preferences, and the latest public progress response in local
extension storage. The `alarms` permission schedules polling and daily reset.
The `notifications` permission displays progress alerts. The host permission is
limited to `www.813.com.tw`; the current API endpoint uses HTTP. Firefox plays
the requested tones with Web Audio in its background page and does not request
the Chrome `offscreen` permission. No Android support is selected.

The generated package can be rebuilt from the separate readable source ZIP
using the included `AMO_BUILD_README.md`. The source manifest is retained as-is;
the build script applies the Firefox background-page and Gecko metadata only to
`dist-firefox/` and removes the marked Chrome-only offscreen bridge from its
background script. The build records SHA-256 hashes in `artifacts/SHA256SUMS.txt`.

## Package and source archive

Run `node scripts/build-firefox.mjs`. Upload only
`artifacts/813-reminder-firefox-1.0.9.zip` as the add-on package and attach
`artifacts/813-reminder-firefox-1.0.9-source.zip` as the readable source archive
if requested. The source ZIP contains the original extension files and tests,
build script, privacy policy, and release notes. It contains no dependencies,
generated output, credentials, or user state.
