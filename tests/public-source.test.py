import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('public_check', ROOT / 'ops/check_public.py')
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)


class PublicSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.root)], check=True)

    def add(self, path, body):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
        subprocess.run(['git', '-C', str(self.root), 'add', '--', path], check=True)

    def test_source_and_placeholder_config_are_allowed(self):
        self.add('app.js', 'export const version = "alpha";')
        self.add('.env.example', 'DISCORD_WEBHOOK_URL=')
        self.assertEqual(public.check(self.root), (2, []))

    def test_forced_media_private_catalog_and_credentials_are_blocked(self):
        for path in ['materials/reference.txt', 'clip.mp4', '.env.local', 'ncs-catalog.json']:
            self.add(path, 'private')
        count, failures = public.check(self.root)
        self.assertEqual(count, 4)
        self.assertEqual(len(failures), 4)

    def test_secret_detection_checks_index_not_worktree_and_does_not_echo_value(self):
        value = 'ghp_' + 'A' * 36
        self.add('settings.js', value)
        (self.root / 'settings.js').write_text('removed only from worktree')
        self.assertEqual(public.check(self.root)[1], [('settings.js', 'possible secret')])
        result = subprocess.run(['python3', str(ROOT / 'ops/check_public.py'), str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(value, result.stdout + result.stderr)

    def test_missing_private_catalog_loads_empty_server_catalog(self):
        import shutil
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('server.py', 'montage.py'):
                shutil.copyfile(ROOT / name, root / name)
            result = subprocess.run(['python3', '-c', 'import server; assert server.TRACKS == {}'], cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
