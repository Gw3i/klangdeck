# TypeScript refactor verification

Verified on 27 November 2026 on an Apple M4 Max running macOS, with Node 24 and Electron 45.5.0.

## Scope

The renderer, Electron processes, Chrome companion, tests, and build scripts are maintained in TypeScript. Generated JavaScript is ignored. The migration used Claude Code Opus 5.5 and its actual `/simplify` review, followed by independent packaged-app checks.

Intentional interface changes: remove the number beside the logo and the square Stop button; display `klangdeck` in macOS. Escape still stops playback. The bundle ID and original `~/Library/Application Support/Klangdeck` data location are preserved.

## Checks

| Check | Result |
| --- | --- |
| Fresh `npm ci` | Passed; existing lockfile inconsistency repaired |
| Strict typecheck across four runtime projects | Passed, including unused-variable and unused-parameter checks |
| Unit tests | 24 passed; original test cases retained |
| Simulated-microphone WebRTC loopback | 23 passed against built extension code |
| Packaged visual, data, and interaction checks | 15 passed |
| Packaged native-host checks | 13 passed |
| Compiled app assets | Matched packaged assets byte-for-byte |
| Existing artwork, license notices, extension manifest | Unchanged |

The board and settings screenshots matched the pre-refactor baseline pixel-for-pixel outside the intentionally changed header. Other computed styles matched. Existing sound bytes, bank state, icons, and lighting settings survived unchanged. Keyboard and mouse playback, key travel, Escape-to-stop, imports, icon selection, and persistence were exercised.

The packaged Chrome native host delivered test audio byte-for-byte using the renamed executable. No real Chrome profile or meeting was used.

## Rendering

A 600-frame sample measured 59.98 fps, a 17.6 ms p95 frame interval, and 0.9 ms p95 CPU render time. The scene retained 66 draw calls and 111,994 triangles. Reduce Motion froze animation. At 0% fill, red and blue selections produced identical decoded screenshots, with no reflection or idle rendering.

These measurements describe this Mac, not other hardware or end-to-end audio latency.

## Limits

A real Google Meet call and remote participant audibility still need manual verification. The app remains a local Apple Silicon build without Developer ID signing or notarization. Global shortcut registration is checked; physical shortcut activation remains a manual check.
