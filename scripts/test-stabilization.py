"""Required behavioral suites on disposable MySQL; never loads .env.

--docker uses an already cached MySQL 8.4 image, tmpfs data, a random
loopback port and a temporary Unix-socket proxy. Nothing is downloaded.
The default uses an existing local mysqld with networking disabled.
"""
import os
import pathlib
import select
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import uuid

repo = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix='csa-product-sync-', dir='/private/tmp' if pathlib.Path('/private/tmp').exists() else '/tmp'))
process = None
container = None
proxy = None
try:
    if '--docker' in sys.argv:
        container = f'csa-stabilization-{uuid.uuid4().hex[:12]}'
        subprocess.run(['docker', 'run', '--pull=never', '--rm', '-d', '--name', container,
            '--tmpfs', '/var/lib/mysql', '--tmpfs', '/var/run/mysqld',
            '--publish', '127.0.0.1::3306', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
            '-e', 'MYSQL_ROOT_HOST=%', 'mysql:8.4'], check=True, stdout=subprocess.DEVNULL)
        port_text = subprocess.check_output(['docker', 'port', container, '3306/tcp'], text=True).strip()
        host, port = port_text.rsplit(':', 1)
        assert host == '127.0.0.1'
        target = (host, int(port))
        for attempt in range(600):
            try:
                with socket.create_connection(target, timeout=1) as connection:
                    if connection.recv(16):
                        break
            except OSError:
                pass
            time.sleep(.2)
        else:
            raise RuntimeError('Disposable MySQL 8.4 did not become ready.')

        class Forward(socketserver.BaseRequestHandler):
            def handle(self):
                with socket.create_connection(target, timeout=10) as remote:
                    remote.settimeout(None)
                    peers = [self.request, remote]
                    while True:
                        ready, _, _ = select.select(peers, [], [], 60)
                        if not ready:
                            return
                        for source in ready:
                            chunk = source.recv(65536)
                            if not chunk:
                                return
                            (remote if source is self.request else self.request).sendall(chunk)

        class Proxy(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
        proxy = Proxy(str(root / 'mysql.sock'), Forward)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
    else:
        binary = shutil.which('mysqld')
        if not binary:
            raise RuntimeError('Use --docker with the cached MySQL 8.4 image, or provide mysqld.')
        with (root / 'init.log').open('w') as log:
            subprocess.run([binary, '--no-defaults', '--initialize-insecure', f'--datadir={root}/data'], check=True, stdout=log, stderr=log)
        process = subprocess.Popen([binary, '--no-defaults', f'--datadir={root}/data', f'--socket={root}/mysql.sock',
            '--skip-networking', f'--pid-file={root}/mysql.pid', f'--log-error={root}/server.log'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for attempt in range(300):
            if (root / 'mysql.sock').exists():
                break
            if process.poll() is not None:
                raise RuntimeError((root / 'server.log').read_text())
            time.sleep(.1)
        else:
            raise RuntimeError('Disposable MySQL did not become ready.')

    # Exclude inherited provider/DB configuration and all credentials.
    env = {key: os.environ[key] for key in ['PATH', 'TMPDIR'] if key in os.environ}
    env.update(PRODUCT_SYNC_TEST_SOCKET=str(root / 'mysql.sock'),
        STOREFRONT_TEST_SOCKET=str(root / 'mysql.sock'), REQUIRE_STABILIZATION_INTEGRATION='true')
    tests = ['memberFinancial', 'localLineOrders', 'enterprisePricing', 'productSync',
        'productFarmStock', 'storefront', 'squareProductCreation', 'squareProductImages']
    result = subprocess.run(['node', '--test', '--test-concurrency=1',
        *[f'apps/api/lib/{name}.integration.test.js' for name in tests]], env=env, cwd=repo)
    raise SystemExit(result.returncode)
finally:
    if proxy:
        proxy.shutdown()
        proxy.server_close()
    if process:
        process.terminate()
        process.wait(timeout=30)
    if container:
        subprocess.run(['docker', 'stop', '-t', '10', container], stdout=subprocess.DEVNULL, check=False)
    shutil.rmtree(root)
