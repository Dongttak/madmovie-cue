# Alpha server access

Local waveform analysis and browser-only exports need no account. Server-side NCS planning
and rendering require an operator-created alpha account over HTTPS. This is a small private
alpha access gate; self-service registration, password recovery and billing are not included.

Use the page's **서버 로그인** link, enter the account, then follow **CUE로 돌아가기**
in the HTTPS tab. Never enter the password on HTTP. The public HTTP page still supports local
work and catalog browsing, but server-processing requests return 426 without forwarding uploads.
If HTTPS times out, the operator must fix TCP 443 ingress before server rendering is available.

## Operator setup

1. Adapt `ops/nginx.example.conf` to your hostname, certificate and installation paths.
   The two CUE locations using `auth_basic` must reference the same password file.
   Configure a valid TLS certificate and permit TCP 443 in the host/cloud firewalls.
2. Create `/etc/nginx/cue-alpha.htpasswd` with an account using `htpasswd -cB` interactively.
   Install it as root, group-readable only by Nginx (typically root:www-data, mode 0640).
   Account names must match `[a-zA-Z0-9_-]{1,64}`. Use unique accounts for separate people.
   Keep this file and plaintext credentials out of the repository. See
   [Nginx's authentication guide](https://docs.nginx.com/nginx/admin-guide/security-controls/configuring-http-basic-authentication/).
3. Create `/var/www/cue/alpha-access.html` containing a short login-success message and a
   link to `/`. The proxy serves it only after authentication. Match the example's root path.
4. Use `ops/cue-api.example.service`, adapting its application path. `StateDirectory=cue-render`
   creates private persistent quota storage. It enables `CUE_REQUIRE_USER=1` and sets
   `CUE_USAGE_DB=/var/lib/cue-render/usage.sqlite3`. The API must bind to 127.0.0.1.
5. Run `nginx -t`, reload Nginx, restart the service, and verify the matrix below.

Nginx verifies Basic credentials and **overwrites** `X-CUE-User` and `X-Forwarded-Proto`
before proxying. It removes the Authorization header from upstream requests. The API requires
the verified username and HTTPS marker before reading the upload or starting media work.
Do not expose port 5174 or trust these headers from an unauthenticated proxy. Other processes
on the same host are trusted; this header boundary does not defend against a compromised host.

## Limits

Per account, in the preceding rolling 3,600 seconds:

- 30 planning attempts (`/api/ncs/plan`).
- 6 video-processing attempts (`/api/ncs/render`, `/api/ncs/montage` combined).
- 500 MiB of declared request bodies across these routes.

Attempts are charged before body reads; cancelled, invalid and failed requests consume quota.
The SQLite transaction reserves capacity atomically and preserves usage across service restarts.
Expired entries are deleted during admission. A full/unavailable database rejects processing.
Deleting the database resets usage; it is operational state, not a media archive.

The proxy additionally limits protected API/login requests per source IP to 10/minute with
a burst of 10, including failed logins. Shared-network users share this IP limit. The existing
150 MiB request limit, single render slot, timeouts and media sandbox remain in place.
This is an alpha allowance, not a billing-grade usage system or an abuse-proof public service.

## Verification

| Request | Expected |
| --- | --- |
| Public GET catalog | 200, metadata only |
| HTTP processing POST | 426, no upstream work |
| HTTPS processing/login without credentials | 401 |
| HTTPS with incorrect password or spoofed identity header | 401 |
| HTTPS login with valid credentials | 200, success page |
| Valid authenticated processing | Normal plan/render response |
| Seventh processing attempt in an hour | 429, before work |
| Same account after API restart | Existing usage retained |
| Missing proxy identity at the loopback API | 401 |

Run `npm run test:security` for identity rejection, concurrent quota admission, persistence,
expiration, cross-origin rejection and the existing upload/runtime checks. Separately test
the actual Nginx configuration and a synthetic render. Local TLS verification does not prove
that browsers outside the server can reach port 443.
