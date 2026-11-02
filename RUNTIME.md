# Pinned media runtime and per-job isolation

The public alpha includes no FFmpeg executable, provider audio/catalog or production credentials.
The optional API remains bound to loopback. Local browser analysis does not need this runtime.

## Runtime selection

`media.py` centralizes **every FFmpeg/FFprobe call in the API and montage renderer**.
Set both variables for a sandboxed deployment:

```bash
export CUE_MEDIA_BIN=/opt/cue-media/current/bin
export CUE_BWRAP=/opt/cue-media/bwrap
python3 server.py
```

A configured but missing tool or a failed sandbox is an error. There is no automatic unsandboxed
fallback. Without these variables, developer mode uses tools from PATH without isolation;
that mode is for trusted local data, not untrusted public uploads.

The pinned ARM64 package and SHA-256 are in `ops/media-runtime.json`. It is an immutable
BtbN release linked through [FFmpeg's download page](https://ffmpeg.org/download.html),
not an FFmpeg-project binary release. It reports `n9.0.2-42-gd7643a0fe3-20261101`.
Verify the downloaded archive against that manifest **before** extracting/installing it.
Extract as a regular user, then install `bin/ffmpeg`, `bin/ffprobe` and `LICENSE.txt` into a
root-owned, non-writable-by-worker directory. Keep the archive/source/license information
when redistributing; this build reports GPL-3.0-or-later. Do not commit binaries to the repo.

Keep releases under `/opt/cue-media/releases/<version>/` and point `/opt/cue-media/current`
to the validated release. Existing `/usr/bin/ffmpeg` is not overwritten. A failed runtime
verification should leave the existing service unchanged. Switching back to an unpatched
runtime is not a safe recovery: stop server-side rendering until a working patched runtime
is available. Keep the browser's local features available separately.

## Ubuntu 24.04 bubblewrap setup

Use a patched `bubblewrap` installation. The validated helper is upstream **0.13.1**, built
without setuid from the source archive/checksum in `ops/bwrap-runtime.json`. Ubuntu
`0.9.0-1ubuntu0.3` reverted the CVE-2026-87766 fix; do not copy that binary into this setup.
Build the pinned source as a regular user (Meson/Ninja and libcap development headers):

```bash
meson setup build bubblewrap-0.13.1 --buildtype=release -Dman=disabled -Dtests=false -Db_pie=true '-Dc_args=["-fstack-protector-strong","-D_FORTIFY_SOURCE=3"]' '-Dc_link_args=["-Wl,-z,relro,-z,now"]'
meson compile -C build
```

Then install only the resulting helper and load the narrow executable-specific profile:

```bash
sudo install -d -m 755 /opt/cue-media
sudo install -m 755 /path/to/validated-build/bwrap /opt/cue-media/bwrap
sudo install -m 644 ops/cue-bwrap.apparmor /etc/apparmor.d/opt.cue-media.bwrap
sudo apparmor_parser -r /etc/apparmor.d/opt.cue-media.bwrap
```

Preserve the helper's `COPYING` file and build manifest alongside the binary.
[Upstream advisory and fixed versions](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx).

This permits user namespaces for this sandbox helper. It does **not** disable the system's
`kernel.apparmor_restrict_unprivileged_userns` protection. On other distributions, configure
bubblewrap according to their policy rather than weakening global restrictions.
[Ubuntu's user-namespace explanation](https://documentation.ubuntu.com/release-notes/24.04/).

Each media invocation gets separate user/PID/network/IPC/UTS namespaces, cleared environment,
no capabilities, read-only system binaries/libraries/runtime (excluding `/usr/local`), synthetic `/dev`, empty `/proc`, private
`/tmp`, and **only the current job directory** mounted writable at `/work`.
Absolute input/output paths must remain within that job. The API can obtain authorized
provider music, while the media worker has no external network access. Existing file/pipe
protocol and demuxer allowlists remain in place. A timeout tears down the worker namespace.

The API process itself needs separate OS protection: use `ops/cue-api.example.service` as a
starting point and adjust only its application path. It applies an unprivileged user, private
home/tmp/devices, read-only system, kernel protection and 768MiB/one-core/96-task bounds.
The service example enables trusted-proxy authentication and persistent quotas. Configure
the matching HTTPS proxy and account file before starting it; see [ACCESS.md](ACCESS.md).
Without that proxy, POSTs fail closed. Local trusted development leaves these env vars unset.
Do not enable public uploads until those controls are independently validated.

## Manual checks

```bash
CUE_MEDIA_BIN=/opt/cue-media/current/bin CUE_BWRAP=/opt/cue-media/bwrap npm run test:media
CUE_MEDIA_BIN=/opt/cue-media/current/bin CUE_BWRAP=/opt/cue-media/bwrap npm run test:security
CUE_MEDIA_BIN=/opt/cue-media/current/bin CUE_BWRAP=/opt/cue-media/bwrap npm run test:server
```

The real isolation tests require the variables above. They verify host-file, host-process,
network and environment separation, rendering/probing within the job and timeout termination.
Without configuration those integration cases explicitly skip; they do not certify isolation.
Run the same render tests under the actual service user and systemd restrictions before rollout.

A newer runtime plus namespaces reduces exposure; it does not guarantee freedom from native
library or kernel vulnerabilities. Continue checking vendor advisories and updating manually.
CI/CD and automatic deployment are not introduced by this setup.
