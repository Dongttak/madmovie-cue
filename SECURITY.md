# Security policy — alpha

CUE is an experimental local-first editor, not a hardened multi-tenant rendering service.
Use the latest alpha source and supported, security-patched Python, Node.js, FFmpeg and
EffectCraft releases. No media-processing binaries are bundled or updated by this repository.

## Reporting

Use GitHub's **Security → Report a vulnerability** when private vulnerability reporting is
available. Do not post credentials, private footage, exploit files or active-service details
in public issues or Discord. If private reporting is unavailable, request a private contact
without publishing exploit details. Security patches are reviewed and released manually;
no CI/CD or automated deployment is configured.

## Trust boundaries

- Public clones contain no provider catalog or audio; the provider API returns an empty list.
- APIs bind to `127.0.0.1` by default. The development HTTP servers are for local use.
- Provider-source URLs and redirects are constrained to approved HTTPS hosts and paths.
- Input size, time ranges, output duration, resolution, connection count and timeouts are bounded.
- Media subprocesses use argument lists, protocol/demuxer allowlists and fixed temporary paths.
- This is not process isolation: FFmpeg still parses untrusted native media formats. Run it as
  an unprivileged worker, isolated from credentials and other services, with resource limits.
- If exposing a service, add HTTPS, authentication, per-user quotas and reverse-proxy limits.
  Origin validation is not authentication. One render slot is not a per-user abuse quota.
- Use only media you are authorized to process/share. Keep webhook tokens out of source,
  logs, frontend bundles and issue attachments.

## Security review — 2026-11-02

The review used local static analysis, dependency/secret scans and synthetic tests on an
isolated loopback server. It did not send exploit uploads to the running public service.

Fixed / hardened before the initial alpha publication:

1. Bounded simultaneous HTTP connections and idle header timeouts; overload returns 503 and
   capacity recovers after timeout. The render semaphore alone did not bound HTTP workers.
2. Source timestamps are limited to 24 hours before frame arithmetic; extreme numeric inputs
   cannot trigger unbounded frame calculations or overflow exceptions.
3. Input dimensions are checked before rendering (maximum 8192 per side and 8192×4320 pixels).
4. Provider and catalog-builder redirects are validated before following them, maintaining the
   existing HTTPS host allowlist through redirects. This is defense in depth; no control of
   the official provider or an actual external-host redirect was demonstrated.
5. The HTTP Server header no longer advertises the Python runtime version.

Checks are documented in `tests/security.test.py`. `npm run test:security` is a manual command.
The public-source guard scans the Git index and is supplemented by a redacted Gitleaks scan.
Bandit's remaining low-severity subprocess/assert findings require contextual review; an
absence of high-severity scanner findings is not proof of safety.

### Media runtime remediation — 2026-11-02

The initial host package `7:6.1.1-3ubuntu5` was older than the Ubuntu fix in
[USN-8915-1](https://ubuntu.com/security/notices/USN-8915-1). CUE no longer uses that
system binary in its configured API service. The application-specific runtime now reports
`n9.0.2-42-gd7643a0fe3-20261101`, from the immutable archive/checksum recorded in
`ops/media-runtime.json`. The upstream CVE-2026-30754 fix commit
`d03483bd265b68db00c9b90f6f48dcf61c5c300d` was verified to be an ancestor of this build's
`d7643a0fe3` source commit. This is not a claim that every library/kernel CVE is eliminated.

The distribution's bubblewrap `0.9.0-1ubuntu0.3` had reverted a sandbox setup fix, per
[USN-8779-2](https://ubuntu.com/security/notices/USN-8779-2). CUE uses a separately built,
non-setuid **bubblewrap 0.13.1**, newer than the upstream advisory's fixed version 0.12.0.
Source hash, binary hash and compiler hardening are recorded in `ops/bwrap-runtime.json`.
The old system tools remain untouched for other software; this remediation is CUE-specific.

`media.py` now routes all API and montage FFmpeg/FFprobe calls through the selected runtime.
With `CUE_BWRAP` configured, a missing tool or failed sandbox aborts processing; it never
falls back to an unsandboxed process. Workers have separate namespaces, no external network,
no host home/process view, cleared environment and only their job folder writable.
The unprivileged service retains read-only-system and memory/CPU/task limits.
See [deployment and isolation checks](RUNTIME.md).

Manual verification includes source-range/render regressions, real sandbox file/network/
environment tests, timeout termination, and synthetic video uploads under the actual service
user and systemd restrictions. No exploit payloads were sent to the public service. Test
counts and production rollout evidence are recorded with the alpha release/PR.

### Still required before untrusted public uploads

Alpha.3 adds proxy-managed alpha accounts, HTTPS-only server processing and persistent
per-account rolling-hour quotas. See [access setup](ACCESS.md). External TCP 443 reachability
is still blocked at this installation; local TLS checks do not establish public reachability.
The alpha must not be treated as a hardened public upload service. Continue tracking these
controls in issue #2. Updating CUE's media runtime does not patch other software on the host.
