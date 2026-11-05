# Third-party components

CUE-authored code is MIT licensed. Third-party software and media keep their own licenses.
The CUE license grants no rights to music, gameplay recordings, tutorials or reference edits.

| Component | Use | License / source |
| --- | --- | --- |
| Lucide static icons 1.68.0 | Bundled selected SVG icons | ISC, with Feather-derived icons under MIT; complete upstream license in `dist/vendor/lucide/LICENSE`, pinned hashes in `dist/vendor/SOURCES.json`; https://lucide.dev/license |
| Radix Colors 3.0.0 | Bundled Sage/Lime dark CSS scales | MIT; complete license in `dist/vendor/radix/LICENSE`, pinned hashes in `dist/vendor/SOURCES.json`; https://github.com/radix-ui/colors |
| axe-core / Playwright adapter | Development-only accessibility scanning | MPL-2.0; https://github.com/dequelabs/axe-core-npm |
| Pretendard Variable | Bundled Korean font | SIL OFL 1.1; complete license in `dist/fonts/OFL.txt`, pinned source/hash in `dist/fonts/SOURCE.txt` |
| TypeScript | Development-only type checking | Apache-2.0; https://github.com/microsoft/TypeScript |
| Playwright | Development-only browser testing | Apache-2.0; https://github.com/microsoft/playwright |
| FFmpeg / FFprobe | Separately installed rendering tools | Build-dependent LGPL/GPL; https://ffmpeg.org/legal.html |
| Bubblewrap | Optional separately installed per-job sandbox | LGPL-2.1-or-later; https://github.com/containers/bubblewrap |
| EffectCraft | Optional separately installed compositor | MIT OR Apache-2.0; https://github.com/storytold/effectcraft/tree/v0.17.0 |

FFmpeg and EffectCraft executables are not bundled. The unchanged system FFmpeg reports GPL-2.0-or-later, while the pinned CUE runtime reports
GPL-3.0-or-later. Inspect your own build with `ffmpeg -L` before redistributing executables
or container images. A CLI integration does not relicense the third-party executable as MIT.

No NCS audio, provider catalog, pro footage, reference videos, rendered music videos or
commercial Twixtor plug-in are included in this source release. NCS's creator-video policy
does not by itself establish a music-supply license for this platform:
https://ncs.io/usage-policy . Obtain appropriate rights before enabling provider integrations.

Backend tests synthesize audio/video locally. `tests/fixtures/ncs-catalog.json` is synthetic
test metadata; its URLs are placeholders, not a usable music library. Tests mock downloads.
