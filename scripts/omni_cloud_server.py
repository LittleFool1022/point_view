#!/usr/bin/env python3
"""OMNI 单租户点云上传参考接口。默认仅回环监听，不创建公网入口。"""
import argparse
import hashlib
import hmac
import json
import os
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CHUNK_SIZE = 1024 * 1024
MAX_BYTES = 512 * 1024 * 1024
ORIGINS = {'http://tauri.localhost', 'https://tauri.localhost', 'http://127.0.0.1:4174', 'http://localhost:4174', 'http://127.0.0.1:5174', 'http://localhost:5174'}


class UploadError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class CloudServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, storage, token='', origins=None):
        self.storage = Path(storage).resolve()
        self.storage.mkdir(parents=True, exist_ok=True)
        self.token, self.origins = token, set(origins or ORIGINS)
        self.locks, self.locks_guard = {}, threading.Lock()
        super().__init__(address, Handler)

    def lock(self, upload_id):
        with self.locks_guard:
            return self.locks.setdefault(upload_id, threading.Lock())

    def paths(self, upload_id):
        return [self.storage / f'{upload_id}{suffix}' for suffix in ('.json', '.part', '.pcd')]

    def load(self, upload_id):
        meta, _, _ = self.paths(upload_id)
        if not meta.exists():
            raise UploadError(404, '上传任务不存在')
        return json.loads(meta.read_text())

    def save(self, upload_id, value):
        meta, _, _ = self.paths(upload_id)
        temp = meta.with_suffix('.json.tmp')
        with temp.open('w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, meta)

    def session(self, upload_id):
        meta = self.load(upload_id)
        _, part, final = self.paths(upload_id)
        receipt = meta.get('receipt')
        if receipt and (not final.exists() or final.stat().st_size != meta['bytes']):
            raise UploadError(409, '云端文件暂不可用')
        return {'uploadId': upload_id, 'offset': meta['bytes'] if receipt else part.stat().st_size if part.exists() else 0,
                'chunkSize': CHUNK_SIZE, **({'receipt': receipt} if receipt else {})}


class Handler(BaseHTTPRequestHandler):
    server: CloudServer
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass  # 不输出认证头、文件内容或客户端路径。

    def reply(self, status, value):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Content-Range')
        self.send_header('Access-Control-Allow-Methods', 'POST, PUT, GET, OPTIONS')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def authorize(self):
        origin = self.headers.get('Origin')
        if origin and origin not in self.server.origins:
            raise UploadError(403, '来源不允许')
        if self.command != 'OPTIONS' and self.server.token:
            provided = self.headers.get('Authorization', '')
            if not hmac.compare_digest(provided.encode(), f'Bearer {self.server.token}'.encode()):
                raise UploadError(401, '认证未通过')

    def body(self, maximum):
        if self.headers.get('Transfer-Encoding'):
            raise UploadError(400, '不支持传输编码')
        try:
            size = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            raise UploadError(400, '请求大小无效')
        if size < 0 or size > maximum:
            raise UploadError(413, '请求过大或大小无效')
        self.connection.settimeout(30)
        data = self.rfile.read(size)
        if len(data) != size:
            raise UploadError(400, '请求未传完整')
        return data

    def dispatch(self):
        self.authorize()
        if self.command == 'OPTIONS':
            return self.reply(200, {'ok': True})
        prefix = '/api/v1/pointcloud-uploads'
        if self.path == prefix and self.command == 'POST':
            meta = json.loads(self.body(16384))
            if not isinstance(meta, dict):
                raise UploadError(400, '项目信息无效')
            upload_id = meta.get('sha256', '')
            size, points = meta.get('bytes'), meta.get('points')
            filename = meta.get('fileName', '')
            if not isinstance(upload_id, str) or not re.fullmatch('[0-9a-f]{64}', upload_id):
                raise UploadError(400, '摘要无效')
            if type(size) is not int or not 0 < size <= MAX_BYTES:
                raise UploadError(413, '文件大小超限')
            if type(points) is not int or not 0 <= points <= 2**53 - 1:
                raise UploadError(400, '点数无效')
            if not isinstance(filename, str) or not 1 <= len(filename) <= 255 or not filename.lower().endswith('.pcd') or re.search(r'[/\\\x00-\x1f]', filename):
                raise UploadError(400, 'PCD 文件名无效')
            if not all(isinstance(meta.get(key), str) and 0 < len(meta[key]) <= 256 for key in ('name', 'projectId')):
                raise UploadError(400, '项目名称无效')
            # 文件名只作为元数据；落盘路径完全由服务端校验后的摘要构造。
            with self.server.lock(upload_id):
                path, _, _ = self.server.paths(upload_id)
                if path.exists():
                    old = self.server.load(upload_id)
                    if old['bytes'] != size or old['points'] != points:
                        raise UploadError(409, '相同摘要的文件信息不一致')
                else:
                    self.server.save(upload_id, {key: meta[key] for key in ('projectId', 'name', 'fileName', 'bytes', 'sha256', 'points')})
                return self.reply(200, self.server.session(upload_id))
        match = re.fullmatch(prefix + r'/([0-9a-f]{64})(/complete)?', self.path)
        if not match:
            raise UploadError(404, '接口不存在')
        upload_id, complete = match.groups()
        with self.server.lock(upload_id):
            meta = self.server.load(upload_id)
            _, part, final = self.server.paths(upload_id)
            if self.command == 'GET' and not complete:
                return self.reply(200, self.server.session(upload_id))
            if self.command == 'PUT' and not complete:
                content_range = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', self.headers.get('Content-Range', ''))
                if not content_range:
                    raise UploadError(400, '上传范围无效')
                start, end, total = map(int, content_range.groups())
                if meta.get('receipt') or final.exists() or total != meta['bytes'] or start != (part.stat().st_size if part.exists() else 0):
                    raise UploadError(409, '上传偏移不一致')
                if end < start or end >= total or end - start + 1 > CHUNK_SIZE:
                    raise UploadError(400, '块大小或范围无效')
                data = self.body(CHUNK_SIZE)
                if len(data) != end - start + 1:
                    raise UploadError(400, '块大小不一致')
                with part.open('ab') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                return self.reply(200, {'uploadId': upload_id, 'offset': end + 1})
            if self.command == 'POST' and complete:
                self.body(16384)
                if meta.get('receipt'):
                    return self.reply(200, self.server.session(upload_id)['receipt'])
                source = final if final.exists() else part
                if not source.exists() or source.stat().st_size != meta['bytes']:
                    raise UploadError(409, '文件未上传完整')
                digest = hashlib.sha256()
                with source.open('rb') as stream:
                    header = stream.read(65536)
                    digest.update(header)
                    while chunk := stream.read(CHUNK_SIZE):
                        digest.update(chunk)
                if digest.hexdigest() != meta['sha256']:
                    # 坏内容无法通过续传修正；只重置该任务的临时部分，保留任务元数据。
                    if source == part:
                        part.unlink()
                    raise UploadError(422, '文件摘要校验失败')
                fields = re.search(rb'(?m)^FIELDS\s+([^\r\n]+)', header)
                count = re.search(rb'(?m)^POINTS\s+(\d+)', header)
                if not fields or not {b'x', b'y', b'z'}.issubset(set(fields[1].split())) or not count or int(count[1]) != meta['points'] or not re.search(rb'(?m)^DATA\s+(ascii|binary|binary_compressed)\s*\r?\n', header):
                    if source == part:
                        part.unlink()
                    raise UploadError(422, 'PCD 头校验失败')
                if source != final:
                    os.replace(part, final)
                receipt = {'state': 'completed', 'objectId': f'pcd_{upload_id}', 'sha256': upload_id, 'bytes': meta['bytes'],
                           'completedAt': datetime.now(timezone.utc).isoformat()}
                self.server.save(upload_id, {**meta, 'receipt': receipt})
                return self.reply(200, receipt)
            raise UploadError(405, '方法不允许')

    def handle_request(self):
        try:
            self.dispatch()
        except UploadError as error:
            self.close_connection = True
            self.reply(error.status, {'message': error.message})
        except (ValueError, TypeError, KeyError):
            self.close_connection = True
            self.reply(400, {'message': '请求格式无效'})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (OSError, TimeoutError):
            self.close_connection = True
            try:
                self.reply(503, {'message': '存储或网络暂不可用'})
            except OSError:
                pass

    do_OPTIONS = do_GET = do_POST = do_PUT = handle_request


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8788)
    parser.add_argument('--storage', type=Path, required=True)
    parser.add_argument('--token-file', type=Path)
    parser.add_argument('--origin', action='append', default=[])
    args = parser.parse_args()
    token = args.token_file.read_text().strip() if args.token_file else ''
    if args.bind not in ('127.0.0.1', '::1', 'localhost') and not token:
        parser.error('非回环监听必须通过 --token-file 提供 Bearer 凭证')
    server = CloudServer((args.bind, args.port), args.storage, token, ORIGINS | set(args.origin))
    print(f'Cloud upload reference listening on {args.bind}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
