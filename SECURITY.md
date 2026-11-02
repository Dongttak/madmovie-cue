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

### Outstanding environment risk

The development/previous deployment host reported FFmpeg `7:6.1.1-3ubuntu5` during review.
It predates the patched Ubuntu 24.04 package listed in
[USN-8915-1](https://ubuntu.com/security/notices/USN-8915-1),
`7:6.1.1-3ubuntu5+esm15`. That notice describes denial-of-service and potential code-execution
issues in specially crafted media. Applicability of each exploit to CUE's permitted formats
was not demonstrated. Do not assume application-level input checks fix native-library CVEs.

The available package candidate on that host was the same unpatched version, and Ubuntu
Pro/ESM Apps was not attached. Updating or replacing the media-processing runtime and
retesting it remains required before accepting untrusted public uploads. Publishing the
source does not update the existing server or certify its security. Operating-system updates,
TLS configuration and deployment hardening are separate from this source review.
