import hashlib
import http.client
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('omni_cloud', Path(__file__).with_name('omni_cloud_server.py'))
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
DATA = b'VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n1 2 3\n'


class CloudTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = cloud.CloudServer(('127.0.0.1', 0), self.temp.name, 'test-token')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.digest = hashlib.sha256(DATA).hexdigest()
        self.prefix = '/api/v1/pointcloud-uploads'
        self.meta = dict(projectId='project', name='本机验收', fileName='sample.pcd', bytes=len(DATA), sha256=self.digest, points=1)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, method, path, value=None, headers=None):
        auth = {'Authorization': 'Bearer test-token'}
        auth.update(headers or {})
        body = json.dumps(value).encode() if isinstance(value, dict) else value
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body=body, headers=auth)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def put(self, start, data):
        return self.call('PUT', self.prefix + '/' + self.digest, data,
                         {'Content-Range': f'bytes {start}-{start + len(data) - 1}/{len(DATA)}'})

    def test_resume_commit_dedup_and_persist(self):
        self.assertEqual(self.call('POST', self.prefix, self.meta)[1]['offset'], 0)
        self.assertEqual(self.put(0, DATA[:30])[1]['offset'], 30)
        self.assertEqual(self.call('POST', self.prefix, self.meta)[1]['offset'], 30)
        self.assertEqual(self.put(0, DATA[:30])[0], 409)
        self.assertEqual(self.put(30, DATA[30:])[0], 200)
        status, receipt = self.call('POST', self.prefix + '/' + self.digest + '/complete', {})
        self.assertEqual(status, 200)
        self.assertEqual(receipt['sha256'], self.digest)
        self.assertEqual((Path(self.temp.name) / (self.digest + '.pcd')).read_bytes(), DATA)
        self.assertEqual(self.call('POST', self.prefix, self.meta)[1]['receipt'], receipt)
        self.assertEqual(self.call('POST', self.prefix + '/' + self.digest + '/complete', {})[1], receipt)
        # 新实例从相同存储恢复完成回执，不依赖内存进度。
        other = cloud.CloudServer(('127.0.0.1', 0), self.temp.name, 'test-token')
        try:
            self.assertEqual(other.session(self.digest)['receipt'], receipt)
        finally:
            other.server_close()

    def test_incomplete_and_bad_content_never_complete(self):
        self.call('POST', self.prefix, self.meta)
        self.assertEqual(self.call('POST', self.prefix + '/' + self.digest + '/complete', {})[0], 409)
        self.put(0, b'X' * len(DATA))
        self.assertEqual(self.call('POST', self.prefix + '/' + self.digest + '/complete', {})[0], 422)
        self.assertEqual(self.call('POST', self.prefix, self.meta)[1]['offset'], 0)
        self.assertFalse((Path(self.temp.name) / (self.digest + '.pcd')).exists())

    def test_auth_origin_and_filename(self):
        self.assertEqual(self.call('POST', self.prefix, self.meta, {'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.call('OPTIONS', self.prefix, headers={'Origin': 'https://untrusted.invalid'})[0], 403)
        self.assertEqual(self.call('OPTIONS', self.prefix, headers={'Origin': 'http://tauri.localhost', 'Authorization': ''})[0], 200)
        self.assertEqual(self.call('POST', self.prefix, {**self.meta, 'fileName': '../sample.pcd'})[0], 400)
        self.assertEqual(self.call('POST', self.prefix, {**self.meta, 'bytes': cloud.MAX_BYTES + 1})[0], 413)

    def test_matching_digest_still_requires_valid_pcd(self):
        bad = b'not a point cloud'
        self.digest = hashlib.sha256(bad).hexdigest()
        self.call('POST', self.prefix, {**self.meta, 'sha256': self.digest, 'bytes': len(bad)})
        self.call('PUT', self.prefix + '/' + self.digest, bad, {'Content-Range': f'bytes 0-{len(bad) - 1}/{len(bad)}'})
        self.assertEqual(self.call('POST', self.prefix + '/' + self.digest + '/complete', {})[0], 422)


if __name__ == '__main__':
    unittest.main()
