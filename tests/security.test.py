import http.client
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cue_security_server', ROOT / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class SecurityTests(unittest.TestCase):
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
