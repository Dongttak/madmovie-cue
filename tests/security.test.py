import http.client
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import socket
import subprocess
import threading
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cue_security_server', ROOT / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class SecurityTests(unittest.TestCase):
    def test_authenticated_mode_requires_loopback_and_persistent_storage(self):
        with patch.dict(os.environ, {'CUE_REQUIRE_USER': '1', 'CUE_USAGE_DB': ''}):
            with self.assertRaises(ValueError):
                server.make_server(port=0)
        with patch.dict(os.environ, {'CUE_REQUIRE_USER': '1', 'CUE_USAGE_DB': '/tmp/not-used.sqlite3'}):
            with self.assertRaises(ValueError):
                server.make_server(host='0.0.0.0', port=0)

    def test_authenticated_requests_reject_missing_duplicate_or_invalid_identity_before_upload(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CUE_REQUIRE_USER': '1', 'CUE_USAGE_DB': directory + '/usage.sqlite3'}):
            api = server.make_server(port=0)
        # Database is not needed for rejected requests; its temporary directory is gone.
        worker = threading.Thread(target=api.serve_forever, daemon=True); worker.start()
        try:
            for headers in [[], [('X-CUE-User', 'alpha')],
                            [('X-CUE-User', '../bad'), ('X-Forwarded-Proto', 'https')],
                            [('X-CUE-User', 'alpha'), ('X-CUE-User', 'beta'), ('X-Forwarded-Proto', 'https')]]:
                with self.subTest(headers=headers):
                    connection = http.client.HTTPConnection(*api.server_address, timeout=2)
                    connection.putrequest('POST', '/api/ncs/plan')
                    connection.putheader('Content-Length', '1000')
                    for name, value in headers: connection.putheader(name, value)
                    connection.endheaders()  # No upload body: authorization must precede reads.
                    response = connection.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read(); connection.close()
        finally:
            api.shutdown(); api.server_close(); worker.join(timeout=2)

    def test_authenticated_http_admission_charges_before_work_and_rejects_cross_origin(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CUE_REQUIRE_USER': '1', 'CUE_USAGE_DB': directory + '/usage.sqlite3'}):
            api = server.make_server(port=0)
            worker = threading.Thread(target=api.serve_forever, daemon=True); worker.start()
            try:
                with patch.object(server.Handler, 'handle_montage', lambda handler, route: handler.send_json(200, {'ok': True})):
                    def request(extra=None):
                        connection = http.client.HTTPConnection(*api.server_address, timeout=2)
                        headers = {'X-CUE-User': 'alpha', 'X-Forwarded-Proto': 'https'}
                        headers.update(extra or {})
                        connection.request('POST', '/api/ncs/montage', b'{}', headers)
                        response = connection.getresponse(); status = response.status
                        response.read(); connection.close(); return status
                    self.assertEqual(request({'Origin': 'https://attacker.invalid'}), 403)
                    for _ in range(6): self.assertEqual(request(), 200)
                    self.assertEqual(request(), 429)
                    self.assertEqual(request({'X-CUE-User': 'beta'}), 200)
            finally:
                api.shutdown(); api.server_close(); worker.join(timeout=2)

    def test_user_quotas_are_atomic_separate_and_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CUE_REQUIRE_USER': '1', 'CUE_USAGE_DB': directory + '/usage.sqlite3'}):
            api = server.make_server(port=0)
            try:
                # Concurrent admissions cannot overbook the six-render allowance.
                accepted, rejected = [], []
                def reserve():
                    try: api.reserve_usage('alpha', False, 1); accepted.append(True)
                    except server.RequestError as error: rejected.append(error.status)
                workers = [threading.Thread(target=reserve) for _ in range(10)]
                for worker in workers: worker.start()
                for worker in workers: worker.join()
                self.assertEqual(len(accepted), 6)
                self.assertEqual(rejected, [429] * 4)
                for _ in range(30): api.reserve_usage('alpha', True, 1)
                with self.assertRaises(server.RequestError): api.reserve_usage('alpha', True, 1)
                api.reserve_usage('beta', False, 500 * 1024 * 1024)
                with self.assertRaises(server.RequestError): api.reserve_usage('beta', True, 1)
            finally: api.server_close()
            api = server.make_server(port=0)
            try:
                with self.assertRaises(server.RequestError): api.reserve_usage('alpha', False, 1)
                with sqlite3.connect(api.usage_db) as db: db.execute('UPDATE usage SET at = at - 3601')
                api.reserve_usage('alpha', False, 1)
            finally: api.server_close()

    def test_catalog_tool_rejects_redirects_before_contacting_other_hosts(self):
        spec = importlib.util.spec_from_file_location('cue_catalog_security', ROOT / 'ops/build_ncs_catalog.py')
        catalog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(catalog)
        handler = catalog.CatalogRedirectHandler()
        initial = Request('https://ncs.io/example')
        for target in ['http://ncs.io/example', 'https://attacker.invalid/example', 'file:///etc/passwd']:
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(initial, None, 302, 'Found', {}, target)
        self.assertEqual(handler.redirect_request(initial, None, 302, 'Found', {},
            'https://ncs.io/example').host, 'ncs.io')

    def test_music_redirects_cannot_escape_official_host(self):
        handler = server.MusicRedirectHandler()
        initial = Request('https://ncsmusic.s3.eu-west-1.amazonaws.com/tracks/test.mp3')
        for target in ['http://127.0.0.1/private', 'file:///etc/passwd',
                       'https://attacker.invalid/track.mp3',
                       'https://ncsmusic.s3.eu-west-1.amazonaws.com@attacker.invalid/tracks/x.mp3',
                       'https://ncsmusic.s3.eu-west-1.amazonaws.com/tracks/a.mp3?x=1']:
            with self.subTest(target=target), self.assertRaises(server.RequestError):
                handler.redirect_request(initial, None, 302, 'Found', {}, target)
        accepted = handler.redirect_request(initial, None, 302, 'Found', {},
            'https://ncsmusic.s3.eu-west-1.amazonaws.com/tracks/other.mp3')
        self.assertEqual(accepted.host, initial.host)

    def test_extreme_times_are_rejected_before_frame_arithmetic(self):
        for value in [1e308, float('inf'), 10**300, -1]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                server.montage.number(value)
        self.assertEqual(server.montage.number(86400), 86400)

    def test_oversized_resolution_is_rejected_before_render(self):
        for width, height in [(100000, 100000), (8192, 8192), (0, 1080)]:
            metadata = {'streams': [{'codec_type': 'video', 'width': width, 'height': height}], 'format': {'duration': '3'}}
            result = subprocess.CompletedProcess([], 0, json.dumps(metadata))
            with patch.object(server.subprocess, 'run', return_value=result):
                with self.subTest(width=width), self.assertRaises(server.RequestError):
                    server.probe(Path('untrusted'), 'v', time.monotonic()+10)

    def test_idle_header_connections_are_bounded_and_capacity_recovers(self):
        with patch.object(server, 'MAX_CONNECTIONS', 2):
            api = server.make_server(port=0)
        api.connection_timeout = .4
        worker = threading.Thread(target=api.serve_forever, daemon=True)
        worker.start()
        clients = []
        try:
            port = api.server_address[1]
            for _ in range(2):
                client = socket.create_connection(('127.0.0.1', port), timeout=2)
                client.sendall(b'GET /api/ncs/catalog HTTP/1.1\r\nHost: localhost\r\n')
                clients.append(client)
            deadline = time.monotonic()+.3
            while api.connection_slots._value != 0 and time.monotonic() < deadline:
                time.sleep(.005)
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            connection.request('GET', '/api/ncs/catalog')
            response = connection.getresponse()
            self.assertEqual(response.status, 503)
            response.read();connection.close()
            deadline = time.monotonic()+2
            while api.connection_slots._value != 2 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(api.connection_slots._value, 2)
            for client in clients:
                self.assertEqual(client.recv(1), b'')
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            connection.request('GET', '/api/ncs/catalog')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertNotIn('Python', response.getheader('Server'))
            response.read();connection.close()
        finally:
            for client in clients:client.close()
            api.shutdown();api.server_close();worker.join(timeout=2)


if __name__ == '__main__':unittest.main()
