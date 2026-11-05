"""Check staged/tracked source candidates; never publish or print secret values."""
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

MEDIA = {'.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.ecproj'}
PRIVATE = {'ncs-catalog.json', 'ops/LOCAL-OPERATIONS.md', 'ops/manage.sh', 'ops/nginx.conf',
           'ops/cue-api.service', 'ops/renew-certificate.sh', 'ops/ncs-catalog-report.json'}
SECRETS = [re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
           re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}'),
           re.compile(r'https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]{20,}')]


def check(root):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)
    entries = git('ls-files', '--stage', '-z').split(b'\0')
    failures = []
    count = 0
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        name = raw_path.decode('utf-8')
        path = PurePosixPath(name)
        count += 1
        if (path.parts[0] in {'materials', '.venv', 'node_modules', 'test-results', '.git'}
                or name in PRIVATE or name.startswith('ncs-catalog.json.') or path.suffix.lower() in MEDIA | {'.pem', '.key', '.sqlite3', '.htpasswd'}
                or '.sqlite3-' in path.name
                or (path.name.startswith('.env') and path.name != '.env.example')):
            failures.append((name, 'private/media/dependency file'))
            continue
        if metadata.split()[0] == b'120000':
            failures.append((name, 'symlink needs explicit review'))
            continue
        body = git('show', ':' + name)
        try:
            content = body.decode('utf-8')
        except UnicodeDecodeError:
            continue
        if any(pattern.search(content) for pattern in SECRETS):
            failures.append((name, 'possible secret'))
    if count == 0:
        raise ValueError('No indexed files. Stage the public source candidates first.')
    return count, failures


def main():
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    try:
        count, failures = check(root)
    except (ValueError, subprocess.CalledProcessError) as error:
        print('Public-source check could not run:', type(error).__name__, file=sys.stderr)
        return 1
    for name, reason in failures:
        print(f'Blocked {name!r}: {reason}', file=sys.stderr)
    if failures:
        return 1
    print(f'Public-source check passed: {count} indexed files. This is not a full secrets or rights audit.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
