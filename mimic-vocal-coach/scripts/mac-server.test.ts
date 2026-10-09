// The Mac download is a tiny Perl web server (mac/server.pl) plus a double-click bash launcher (mac/Start Mimic.command).
// These tests run the real server against a temp folder and the real launcher against a stubbed `open`, and check the things a
// Mac user would otherwise find out the hard way: right Content-Type (wasm!), Range, no escape from the folder, loopback only,
// the busy-port message, and that the launcher sticks to what bash 3.2 and BSD tools have. Skipped where perl is not installed.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const macDir = join(import.meta.dirname, '..', 'mac');
const serverPl = join(macDir, 'server.pl');
const launcher = join(macDir, 'Start Mimic.command');
const have = (cmd: string, args: string[] = ['--version']) => {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
};
const hasPerl = have('perl', ['-e', '1']);
const hasBash = have('bash', ['-c', ':']);
const bashPath = hasBash ? spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || 'bash' : 'bash';
const hasCurl = have('curl');
const hasTaskset = process.platform === 'linux' && have('taskset', ['-c', '0', 'true']);
const isLinux = process.platform === 'linux';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Plain TCP so nothing normalises the request on the way (Node's http client would refuse a NUL or fix a path). */
function rawRequest(port: number, text: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    sock.setTimeout(20000, () => sock.destroy(new Error('timed out')));
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      const all = Buffer.concat(chunks);
      const cut = all.indexOf('\r\n\r\n');
      if (cut < 0) return reject(new Error(`no complete response (${all.length} bytes)`));
      const [statusLine = '', ...lines] = all.subarray(0, cut).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: all.subarray(cut + 4) });
    });
    sock.write(text);
  });
}

function send(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return rawRequest(port, `${method} ${path} HTTP/1.1\r\nHost: localhost:${port}\r\n${extra}Connection: close\r\n\r\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
}

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

interface Running {
  proc: ChildProcess;
  port: number;
  out: () => string;
  err: () => string;
}

async function startServer(root: string, env: Record<string, string> = {}, port?: number): Promise<Running> {
  const p = port ?? (await freePort());
  const proc = spawn('perl', [serverPl, root], { env: { ...process.env, MIMIC_PORT: '', PORT: String(p), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d));
  proc.stderr?.on('data', (d: Buffer) => (err += d));
  const up = await waitUntil(async () => proc.exitCode === null && (await canConnect(p)));
  if (!up) throw new Error(`server did not come up: ${err}`);
  return { proc, port: p, out: () => out, err: () => err };
}

function exited(proc: ChildProcess, ms = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    const t = setTimeout(() => resolve(null), ms);
    proc.once('exit', (code) => (clearTimeout(t), resolve(code)));
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'mimic-mac-'));
const base = join(scratch, 'site'); // what gets served
const big = randomBytes(5 * 1024 * 1024 + 123); // a multi-MB file that is not a multiple of any chunk size
const files: Record<string, Buffer | string> = {
  'index.html': '<!doctype html><title>Mimic</title><p>home</p>\n',
  'sw.js': 'self.addEventListener("fetch",()=>{});\n',
  'manifest.webmanifest': '{"name":"Mimic Vocal Coach"}\n',
  'data.json': '{"a":1}\n',
  'notes.txt': 'plain\n',
  'icons/icon.png': randomBytes(300),
  'icons/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  'icons/favicon.ico': randomBytes(64),
  'assets/app-AbCd1234.js': 'export const x = 1;\n',
  'assets/engine-Zy9_-xK1.mjs': 'export default 1;\n',
  'assets/style-QwErTy12.css': 'body{margin:0}\n',
  'assets/ort-wasm-simd-threaded-B92PF46Y.wasm': big,
  'assets/font-12345678.woff2': randomBytes(40),
  'assets/font-12345678.woff': randomBytes(40),
  'assets/app-AbCd1234.js.map': '{}\n',
  'assets/plain.js': 'x\n',
  'models/vocal-isolation.onnx': randomBytes(2 * 1024 * 1024 + 7),
  'models/vocal-isolation.json': '{"bytes":1}\n',
  'sub/index.html': 'sub home\n',
  '.hidden': 'dot file\n',
  'with space/hello world.txt': 'spaced\n',
};
const SECRET = 'TOPSECRET-do-not-serve';

beforeAll(() => {
  for (const [name, data] of Object.entries(files)) {
    const f = join(base, name);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, data);
  }
  writeFileSync(join(scratch, 'secret.txt'), SECRET); // next to the served folder, one level up
  try {
    symlinkSync(join(scratch, 'secret.txt'), join(base, 'evil-link.txt'));
    symlinkSync(scratch, join(base, 'evil-dir'));
  } catch {
    /* no symlinks here (Windows without rights): those two cases then pass trivially */
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('mac/ files', () => {
  it('has the launcher, the server and the readme, and the launcher is executable with Unix line endings', () => {
    for (const f of ['server.pl', 'Start Mimic.command', 'README.txt']) expect(existsSync(join(macDir, f)), f).toBe(true);
    const src = readFileSync(launcher, 'utf8');
    expect(src.startsWith('#!/bin/bash\n')).toBe(true);
    expect(src).not.toContain('\r');
    expect(readFileSync(serverPl, 'utf8')).not.toContain('\r');
    if (process.platform !== 'win32') expect(statSync(launcher).mode & 0o111, 'git must keep the executable bit').not.toBe(0);
  });

  it('launcher uses nothing newer than bash 3.2 or GNU-only tools (static check)', () => {
    const src = readFileSync(launcher, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const banned: Array<[RegExp, string]> = [
      [/\b(declare|local|typeset)\s+-[a-zA-Z]*A/, 'associative arrays'],
      [/\b(mapfile|readarray|coproc)\b/, 'mapfile / readarray / coproc'],
      [/\$\{[A-Za-z_][A-Za-z_0-9]*(,,|\^\^|,|\^)\}/, 'case-changing expansions'],
      [/\breadlink\s+-f\b/, 'readlink -f'],
      [/\bsed\s+-[a-zA-Z]*i(\s|$)/, 'sed -i'],
      [/\bdate\s+-d\b/, 'GNU date -d'],
      [/\bgrep\s+-[a-zA-Z]*P/, 'grep -P'],
      [/\|&|&>>/, '|& or &>>'],
      [/\$\{!|\$EPOCH(SECONDS|REALTIME)|\$BASHPID/, 'bash 4+ variables'],
      [/\bsudo\b/, 'sudo'],
      [/\bxargs\s+-[a-zA-Z]*r/, 'GNU xargs -r'],
      [/--[a-z]+-[a-z-]+=/, 'GNU long options with ='],
    ];
    for (const [re, what] of banned) expect(re.test(src), what).toBe(false);
    // no network access except localhost: every URL in the script points at this machine
    for (const m of src.matchAll(/https?:\/\/[^\s"')]+/g)) expect(m[0]).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)[:/]/);
  });

  it.skipIf(!hasBash)('bash -n accepts the launcher', () => {
    const r = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!have('shellcheck'))('shellcheck finds no warnings in the launcher', () => {
    const r = spawnSync('shellcheck', ['-s', 'bash', '-S', 'warning', launcher], { encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('README states the first-run workaround, the browsers, the data location and the licence note', () => {
    const t = readFileSync(join(macDir, 'README.txt'), 'utf8');
    expect(t).toMatch(/bash/);
    expect(t).toMatch(/drag the file/i);
    expect(t).toMatch(/Open Anyway/);
    expect(t).toMatch(/Privacy & Security/);
    expect(t).toMatch(/Safari/);
    expect(t).toMatch(/Chrome/);
    expect(t).toMatch(/microphone/i);
    expect(t).toMatch(/localhost:47321/);
    expect(t).toMatch(/do not post it\s+or share it publicly/);
  });
});

describe.skipIf(!hasPerl)('mac/server.pl', () => {
  let srv: Running;
  beforeAll(async () => {
    srv = await startServer(base);
  });
  afterAll(async () => {
    srv?.proc.kill('SIGTERM');
    await exited(srv.proc);
  });

  it('compiles under this perl (perl -c)', () => {
    const r = spawnSync('perl', ['-c', serverPl], { encoding: 'utf8' });
    expect(r.stderr).toContain('syntax OK');
    expect(r.status).toBe(0);
  });

  it('uses only core modules', () => {
    const used = [...readFileSync(serverPl, 'utf8').matchAll(/^use\s+([A-Z][\w:]*)/gm)].map((m) => m[1]);
    expect(used.sort()).toEqual(['Cwd', 'FindBin', 'IO::Socket::INET', 'POSIX', 'Socket']);
  });

  it('serves the right Content-Type for every kind of file the app has', async () => {
    const cases: Array<[string, string]> = [
      ['/index.html', 'text/html; charset=utf-8'],
      ['/assets/app-AbCd1234.js', 'text/javascript; charset=utf-8'],
      ['/assets/engine-Zy9_-xK1.mjs', 'text/javascript; charset=utf-8'],
      ['/assets/style-QwErTy12.css', 'text/css; charset=utf-8'],
      ['/data.json', 'application/json; charset=utf-8'],
      ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['/assets/ort-wasm-simd-threaded-B92PF46Y.wasm', 'application/wasm'],
      ['/models/vocal-isolation.onnx', 'application/octet-stream'],
      ['/icons/icon.png', 'image/png'],
      ['/icons/logo.svg', 'image/svg+xml'],
      ['/icons/favicon.ico', 'image/x-icon'],
      ['/assets/font-12345678.woff2', 'font/woff2'],
      ['/assets/font-12345678.woff', 'font/woff'],
      ['/notes.txt', 'text/plain; charset=utf-8'],
      ['/assets/app-AbCd1234.js.map', 'application/json; charset=utf-8'],
    ];
    for (const [path, type] of cases) {
      const r = await send(srv.port, path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type'], path).toBe(type);
      expect(r.headers['x-content-type-options'], path).toBe('nosniff');
      expect(Number(r.headers['content-length']), path).toBe(r.body.length);
    }
  });

  it('serves "/" as index.html, ignores the query string, decodes %20, and has no SPA fallback or listings', async () => {
    const home = await send(srv.port, '/');
    expect(home.status).toBe(200);
    expect(home.body.toString()).toBe(files['index.html']);
    expect((await send(srv.port, '/?utm=1#x')).body.toString()).toBe(files['index.html']);
    expect((await send(srv.port, '/with%20space/hello%20world.txt')).body.toString()).toBe('spaced\n');
    expect((await send(srv.port, '/sub/')).body.toString()).toBe('sub home\n');
    for (const p of ['/sub', '/assets/', '/assets', '/icons/', '/missing.js', '/trainer/c/123', '/.hidden', '/assets/.hidden', '/index.html/x']) {
      const r = await send(srv.port, p);
      expect(r.status, p).toBe(404);
      expect(r.headers['content-type'], p).toMatch(/^text\/plain/);
      expect(r.body.toString(), p).not.toContain('<title>');
    }
  });

  it('sets caching headers: no-cache for the shell, immutable for hashed assets', async () => {
    for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/data.json', '/models/vocal-isolation.json', '/assets/plain.js']) {
      expect((await send(srv.port, p)).headers['cache-control'], p).toBe('no-cache');
    }
    for (const p of ['/assets/app-AbCd1234.js', '/assets/engine-Zy9_-xK1.mjs', '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm', '/assets/font-12345678.woff2']) {
      expect((await send(srv.port, p)).headers['cache-control'], p).toBe('public, max-age=31536000, immutable');
    }
  });

  it('answers HEAD with the headers of the GET and no body, and 405 for other methods', async () => {
    const get = await send(srv.port, '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm');
    const head = await send(srv.port, '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(big.length));
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.headers['etag']).toBe(get.headers['etag']);
    const head404 = await send(srv.port, '/nope', {}, 'HEAD');
    expect(head404.status).toBe(404);
    expect(head404.body.length).toBe(0);
    const post = await send(srv.port, '/', {}, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
    expect((await send(srv.port, '/', {}, 'DELETE')).status).toBe(405);
    expect((await rawRequest(srv.port, 'GARBAGE\r\n\r\n')).status).toBe(400);
  });

  it('sends a multi-MB file whole, with the right Content-Length, byte for byte', async () => {
    const r = await send(srv.port, '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(big.length));
    expect(r.body.length).toBe(big.length);
    expect(sha(r.body)).toBe(sha(big));
    expect(r.headers['accept-ranges']).toBe('bytes');
  });

  it('answers conditional requests with 304', async () => {
    const first = await send(srv.port, '/index.html');
    const again = await send(srv.port, '/index.html', { 'If-None-Match': first.headers['etag'] ?? '' });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect((await send(srv.port, '/index.html', { 'If-None-Match': '"other"' })).status).toBe(200);
  });

  it('supports a single Range with 206 and rejects an unsatisfiable one with 416', async () => {
    const path = '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm';
    const n = big.length;
    const ok = async (range: string, from: number, to: number) => {
      const r = await send(srv.port, path, { Range: range });
      expect(r.status, range).toBe(206);
      expect(r.headers['content-range'], range).toBe(`bytes ${from}-${to}/${n}`);
      expect(r.headers['content-length'], range).toBe(String(to - from + 1));
      expect(sha(r.body), range).toBe(sha(big.subarray(from, to + 1)));
    };
    await ok('bytes=0-99', 0, 99);
    await ok('bytes=100-', 100, n - 1);
    await ok('bytes=-50', n - 50, n - 1);
    await ok(`bytes=${n - 10}-${n + 5000}`, n - 10, n - 1); // end past the file is clamped
    await ok('bytes=262100-262300', 262100, 262300); // across the 256 KB read chunk
    await ok(`bytes=${n - 1}-${n - 1}`, n - 1, n - 1);
    await ok(`bytes=-${n + 100}`, 0, n - 1); // a suffix longer than the file is the whole file

    for (const range of [`bytes=${n}-`, `bytes=${n + 10}-${n + 20}`, 'bytes=-0']) {
      const r = await send(srv.port, path, { Range: range });
      expect(r.status, range).toBe(416);
      expect(r.headers['content-range'], range).toBe(`bytes */${n}`);
    }
    // ranges we do not do are answered with the whole file, which is what the spec allows
    for (const range of ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-9', 'bytes=abc']) {
      const r = await send(srv.port, path, { Range: range });
      expect(r.status, range).toBe(200);
      expect(r.body.length, range).toBe(n);
    }
    const head = await send(srv.port, path, { Range: 'bytes=0-9' }, 'HEAD');
    expect(head.status).toBe(206);
    expect(head.body.length).toBe(0);
    // If-Range with a stale validator means "send everything"
    const stale = await send(srv.port, path, { Range: 'bytes=0-9', 'If-Range': '"old"' });
    expect(stale.status).toBe(200);
    expect(stale.body.length).toBe(n);
  });

  it('refuses every way out of the folder and never leaks the file next to it', async () => {
    const attempts = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2fsecret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/assets/../../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/./../secret.txt',
      '//../secret.txt',
      '/%252e%252e/secret.txt', // double encoded: decoded once it is a file name "%2e%2e", which does not exist
      '/%252e%252e%252fsecret.txt',
      '/..%5csecret.txt',
      '/%2e%2e%5csecret.txt',
      '/..\\secret.txt',
      '/assets\\..\\..\\secret.txt',
      '/index.html%00.png',
      '/index.html\0',
      '/%00/../secret.txt',
      '/..%00/secret.txt',
      '/....//secret.txt',
      '/%2e./secret.txt',
      '/.%2e/secret.txt',
      '/evil-link.txt', // a symlink that points outside the folder
      '/evil-dir/secret.txt',
      '/etc/passwd',
      '/%2fetc/passwd',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/%c0%ae%c0%ae/secret.txt', // overlong "..": must stay a plain, missing file name
      '/%zz',
      '/%2',
    ];
    for (const path of attempts) {
      const r = await send(srv.port, path);
      expect([400, 403, 404], `${JSON.stringify(path)} -> ${r.status}`).toContain(r.status);
      expect(r.body.toString('latin1'), path).not.toContain(SECRET);
      expect(r.body.toString('latin1'), path).not.toMatch(/root:.*:0:0/);
    }
    // absolute-form request target and a request line with a path that climbs out
    const abs = await rawRequest(srv.port, 'GET http://localhost/../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect([400, 403, 404]).toContain(abs.status);
    expect(abs.body.toString()).not.toContain(SECRET);
    // the server is still fine afterwards
    expect((await send(srv.port, '/index.html')).status).toBe(200);
  });

  it('handles many parallel requests, including big files, and stays correct', async () => {
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 160; i++) {
      const wantBig = i % 8 === 0;
      const path = wantBig ? '/assets/ort-wasm-simd-threaded-B92PF46Y.wasm' : i % 3 === 0 ? '/index.html' : '/assets/app-AbCd1234.js';
      jobs.push(
        send(srv.port, path).then((r) => {
          expect(r.status).toBe(200);
          expect(r.body.length).toBe(Number(r.headers['content-length']));
          if (wantBig) expect(sha(r.body)).toBe(sha(big));
        }),
      );
    }
    await Promise.all(jobs);
    expect((await send(srv.port, '/')).status).toBe(200);
  });

  it('survives clients that disconnect mid-download or never send anything, and leaves no zombie processes', async () => {
    const aborted: Array<Promise<void>> = [];
    for (let i = 0; i < 12; i++) {
      aborted.push(
        new Promise<void>((resolve) => {
          const s = net.connect({ host: '127.0.0.1', port: srv.port });
          s.write('GET /assets/ort-wasm-simd-threaded-B92PF46Y.wasm HTTP/1.1\r\nHost: x\r\n\r\n');
          s.once('data', () => (s.destroy(), resolve()));
          s.on('error', () => resolve());
        }),
      );
      const idle = net.connect({ host: '127.0.0.1', port: srv.port }); // like a browser's spare connection
      idle.on('error', () => {});
      setTimeout(() => idle.destroy(), 100);
    }
    await Promise.all(aborted);
    expect((await send(srv.port, '/index.html')).status).toBe(200);
    expect(srv.proc.exitCode).toBeNull();
    if (isLinux && srv.proc.pid) {
      const zombies = () =>
        readdirSync('/proc')
          .filter((d) => /^\d+$/.test(d))
          .filter((d) => {
            try {
              const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
              const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
              return rest[0] === 'Z' && Number(rest[1]) === srv.proc.pid;
            } catch {
              return false;
            }
          });
      expect(await waitUntil(() => zombies().length === 0, 5000), 'children are reaped').toBe(true);
    }
  });

  it('prints nothing to stdout or stderr while it works', () => {
    expect(srv.out()).toBe('');
    expect(srv.err()).toBe('');
  });

  it.skipIf(!isLinux)('listens on 127.0.0.1 only (never the network)', () => {
    const hex = srv.port.toString(16).toUpperCase().padStart(4, '0');
    const rows = readFileSync('/proc/net/tcp', 'utf8').split('\n').filter((l) => l.includes(`:${hex} `) && /\s0A\s/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.trim().split(/\s+/)[1], row).toBe(`0100007F:${hex}`);
    // and nothing on IPv6 (the file is absent where IPv6 is switched off)
    if (existsSync('/proc/net/tcp6')) {
      const rows6 = readFileSync('/proc/net/tcp6', 'utf8').split('\n').filter((l) => l.includes(`:${hex} `) && /\s0A\s/.test(l));
      expect(rows6.length).toBe(0);
    }
  });

  it('refuses connections on this machine\'s non-loopback address, if it has one', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return; // a sandbox with only loopback: nothing to try (the /proc check above covers Linux)
    const outcome = await new Promise<string>((resolve) => {
      const s = net.connect({ host: external.address, port: srv.port });
      s.setTimeout(3000, () => (s.destroy(), resolve('timeout')));
      s.on('connect', () => (s.destroy(), resolve('connected')));
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(outcome).not.toBe('connected');
  });
});

describe.skipIf(!hasPerl)('mac/server.pl under load and with bad clients', () => {
  const childrenOf = (pid: number): number[] =>
    readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
          return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid;
        } catch {
          return false;
        }
      })
      .map(Number);

  it('keeps answering after many connect-and-close connections on one CPU (no leak in the table of live children)', async () => {
    // A child that ended between fork() and the parent noting its pid used to stay in that table for ever; once the table was
    // full the server stopped accepting. A cap of 40 (instead of 200) makes the old code wedge within 1500 connections, in about
    // 10 seconds; with a much smaller cap the children are too few to be preempted at the wrong moment and the leak hides.
    const connections = 1500;
    const s = await startServer(base, { MIMIC_MAX_CHILDREN: '40' });
    // The leak needs the server and the client to share one CPU, as on a slow or busy Mac: pin both where taskset exists.
    const hammerSrc = `const net=require('net');const port=${s.port};let started=0,done=0,inflight=0;
      const next=()=>{while(inflight<40&&started<${connections}){started++;inflight++;const c=net.connect({host:'127.0.0.1',port});let d=0;
      const fin=()=>{if(d)return;d=1;inflight--;done++;if(done>=${connections})process.exit(0);else next();};
      c.on('connect',()=>c.destroy());c.on('close',fin);c.on('error',()=>{});}};next();`;
    try {
      if (hasTaskset && s.proc.pid) spawnSync('taskset', ['-cp', '0', String(s.proc.pid)], { stdio: 'ignore' });
      const hammer = hasTaskset
        ? spawn('taskset', ['-c', '0', process.execPath, '-e', hammerSrc], { stdio: 'ignore' })
        : spawn(process.execPath, ['-e', hammerSrc], { stdio: 'ignore' });
      expect(await exited(hammer, 50000), 'the hammer finished, so the server kept accepting').toBe(0);
      expect((await send(s.port, '/index.html')).status).toBe(200);
      expect(s.err()).toBe('');
    } finally {
      s.proc.kill('SIGTERM');
      await exited(s.proc);
    }
  }, 70000);

  it.skipIf(!isLinux)('drops a client that stops reading a big download, and one that connects and says nothing', async () => {
    const s = await startServer(base, { MIMIC_IO_TIMEOUT: '2' });
    // a file much bigger than the kernel's socket buffers, so the server really has to wait for the client
    mkdirSync(join(base, 'stall'), { recursive: true });
    writeFileSync(join(base, 'stall', 'huge.bin'), Buffer.alloc(48 * 1024 * 1024, 7));
    const socks: net.Socket[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const c = net.connect({ host: '127.0.0.1', port: s.port });
        c.on('error', () => {});
        c.write('GET /stall/huge.bin HTTP/1.1\r\nHost: x\r\n\r\n');
        c.pause();
        socks.push(c);
      }
      const silent = net.connect({ host: '127.0.0.1', port: s.port });
      silent.on('error', () => {});
      let silentBytes = 0;
      silent.on('data', (d: Buffer) => (silentBytes += d.length));
      const silentClosed = new Promise<void>((resolve) => silent.on('close', () => resolve()));
      socks.push(silent);
      expect(await waitUntil(() => childrenOf(s.proc.pid as number).length >= 4, 5000), 'the downloads are in flight').toBe(true);
      await silentClosed;
      expect(silentBytes, 'a connection that never sends a request is closed without a reply').toBe(0);
      expect(await waitUntil(() => childrenOf(s.proc.pid as number).length === 0, 12000), 'stalled downloads are given up and their processes end').toBe(true);
      expect((await send(s.port, '/index.html')).status).toBe(200);
    } finally {
      for (const c of socks) c.destroy();
      s.proc.kill('SIGTERM');
      await exited(s.proc);
      rmSync(join(base, 'stall'), { recursive: true, force: true });
    }
  }, 40000);

  it('answers 408 to a request that starts but never finishes', async () => {
    const s = await startServer(base, { MIMIC_IO_TIMEOUT: '1' });
    try {
      const reply = await new Promise<string>((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port: s.port });
        let got = '';
        c.on('data', (d: Buffer) => (got += d.toString('latin1')));
        c.on('close', () => resolve(got));
        c.on('error', () => resolve(got));
        c.write('GET /index.html HTTP/1.1\r\nHost: x\r\n'); // no blank line
      });
      expect(reply).toMatch(/^HTTP\/1\.1 408 /);
    } finally {
      s.proc.kill('SIGTERM');
      await exited(s.proc);
    }
  });

  it('MIMIC_PORT wins over a PORT left over from another project', async () => {
    const wanted = await freePort();
    const decoy = await freePort();
    const proc = spawn('perl', [serverPl, base], { env: { ...process.env, MIMIC_PORT: String(wanted), PORT: String(decoy) }, stdio: 'ignore' });
    try {
      expect(await waitUntil(() => canConnect(wanted))).toBe(true);
      expect(await canConnect(decoy)).toBe(false);
    } finally {
      proc.kill('SIGTERM');
      await exited(proc);
    }
  });

  it('tells every response which folder it serves (the launcher uses this to spot a Mimic started from an older copy)', async () => {
    const s = await startServer(base);
    try {
      const r = await send(s.port, '/manifest.webmanifest');
      expect(r.headers['x-mimic-folder']).toBe(realpathSync(base));
      expect((await send(s.port, '/manifest.webmanifest', { 'If-None-Match': r.headers.etag as string })).headers['x-mimic-folder']).toBe(realpathSync(base));
    } finally {
      s.proc.kill('SIGTERM');
      await exited(s.proc);
    }
  });
});

describe.skipIf(!hasPerl)('mac/server.pl startup', () => {
  it('exits non-zero with one clear line when the port is taken, and prints nothing on stdout', async () => {
    const taken = net.createServer();
    const port = await new Promise<number>((resolve) => taken.listen(0, '127.0.0.1', () => resolve((taken.address() as net.AddressInfo).port)));
    try {
      const proc = spawn('perl', [serverPl, base], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (d: Buffer) => (out += d));
      proc.stderr?.on('data', (d: Buffer) => (err += d));
      const code = await exited(proc);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err.trim().split('\n').length).toBe(1);
      expect(err).toMatch(/port \d+ is already in use/);
      expect(err).toContain(String(port));
    } finally {
      taken.close();
    }
  });

  it('exits non-zero with a clear line for a bad PORT or a missing app folder', async () => {
    const run = (args: string[], env: Record<string, string>) => spawnSync('perl', [serverPl, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 8000 });
    const badPort = run([base], { PORT: 'abc' });
    expect(badPort.status).toBe(1);
    expect(badPort.stderr).toMatch(/PORT must be a number/);
    const huge = run([base], { PORT: '70000' });
    expect(huge.status).toBe(1);
    const missing = run([join(scratch, 'does-not-exist')], { PORT: '47320' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/app folder .* was not found/);
    mkdirSync(join(scratch, 'empty'), { recursive: true });
    const notApp = run([join(scratch, 'empty')], { PORT: '47320' });
    expect(notApp.status).toBe(1);
    expect(notApp.stderr).toMatch(/no index\.html/);
  });

  it('logs one short line per request on stderr only when MIMIC_VERBOSE is set', async () => {
    const s = await startServer(base, { MIMIC_VERBOSE: '1' });
    try {
      await send(s.port, '/index.html');
      await send(s.port, '/nope');
      await send(s.port, '/../secret.txt');
      await waitUntil(() => s.err().split('\n').filter(Boolean).length >= 3, 3000);
      const lines = s.err().split('\n').filter(Boolean);
      expect(lines).toContain('GET /index.html 200');
      expect(lines).toContain('GET /nope 404');
      expect(lines.some((l) => l.startsWith('GET /../secret.txt 403'))).toBe(true);
      expect(s.out()).toBe('');
    } finally {
      s.proc.kill('SIGTERM');
      await exited(s.proc);
    }
  });

  it('keeps working when the port is passed by environment and the app folder is next to server.pl', async () => {
    // the shipped layout: <folder>/server.pl and <folder>/app/
    const bundle = join(scratch, 'bundle');
    mkdirSync(join(bundle, 'app'), { recursive: true });
    copyFileSync(serverPl, join(bundle, 'server.pl'));
    writeFileSync(join(bundle, 'app', 'index.html'), 'shipped layout\n');
    const port = await freePort();
    const proc = spawn('perl', [join(bundle, 'server.pl')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', cwd: tmpdir() });
    try {
      expect(await waitUntil(() => canConnect(port))).toBe(true);
      expect((await send(port, '/')).body.toString()).toBe('shipped layout\n');
    } finally {
      proc.kill('SIGTERM');
      await exited(proc);
    }
  });
});

describe.skipIf(!hasPerl || !hasBash || !hasCurl || process.platform === 'win32')('mac/Start Mimic.command (with a stubbed `open`)', () => {
  const kits: string[] = [];
  const procs: ChildProcess[] = [];
  afterAll(() => {
    for (const p of procs) {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  /** A folder laid out like the download, with a fake `open` that records what it was asked to open. */
  function kit(opts: { withApp?: boolean; slowStart?: number } = {}) {
    const dir = mkdtempSync(join(scratch, 'kit-'));
    kits.push(dir);
    const root = join(dir, 'Mimic for Mac'); // a space in the path, like real life
    mkdirSync(join(root, 'app'), { recursive: true });
    copyFileSync(launcher, join(root, 'Start Mimic.command'));
    chmodSync(join(root, 'Start Mimic.command'), 0o755);
    if (opts.withApp !== false) {
      copyFileSync(serverPl, join(root, 'server.pl'));
      if (opts.slowStart) {
        // a Mac that is busy (first run, a security scan): the server takes this many seconds to get going
        const slow = readFileSync(serverPl, 'utf8').replace('\n', `\nBEGIN { select(undef, undef, undef, ${opts.slowStart}); }\n`);
        writeFileSync(join(root, 'server.pl'), slow);
      }
      writeFileSync(join(root, 'app', 'index.html'), '<title>Mimic</title>');
      writeFileSync(join(root, 'app', 'manifest.webmanifest'), '{"name":"Mimic Vocal Coach"}');
    }
    mkdirSync(join(dir, 'bin'));
    const log = join(dir, 'open.log');
    writeFileSync(join(dir, 'bin', 'open'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(join(dir, 'bin', 'open'), 0o755);
    return { root, log, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } };
  }

  function launch(k: ReturnType<typeof kit>, env: Record<string, string>) {
    const proc = spawn(bashPath, ['Start Mimic.command'], { cwd: k.root, env: { ...k.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    procs.push(proc);
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d));
    proc.stderr?.on('data', (d: Buffer) => (out += d));
    return { proc, out: () => out };
  }
  const opened = (k: ReturnType<typeof kit>) => (existsSync(k.log) ? readFileSync(k.log, 'utf8') : '');

  it('starts the server, shows the banner, opens http://localhost:<port>/ once it answers, and stops on Control-C', async () => {
    const k = kit();
    const port = await freePort();
    const l = launch(k, { MIMIC_PORT: String(port) });
    expect(await waitUntil(() => opened(k).includes(`http://localhost:${port}/`), 15000), l.out()).toBe(true);
    expect(await canConnect(port)).toBe(true);
    expect(l.out()).toContain('Mimic Vocal Coach is running');
    expect(l.out()).toContain(`http://localhost:${port}/`);
    expect(l.out()).toMatch(/Control-C/);
    expect(l.out()).toMatch(/Safari/);
    expect(l.out()).toMatch(/saved in your browser/);
    expect(opened(k).trim().split('\n').length).toBe(1);
    // a second start while it runs: no second server, just the browser again
    const again = launch(k, { MIMIC_PORT: String(port) });
    expect(await exited(again.proc, 15000)).toBe(0);
    expect(again.out()).toMatch(/already running/);
    expect(opened(k).trim().split('\n').length).toBe(2);
    // Control-C goes to the whole foreground group in a terminal
    process.kill(-(l.proc.pid as number), 'SIGINT');
    expect(await exited(l.proc, 8000)).toBe(0);
    expect(l.out()).toMatch(/Mimic has stopped/);
    expect(await waitUntil(async () => !(await canConnect(port)), 5000)).toBe(true);
  }, 60000);

  it('says so, in plain words, when another program holds the port, and does not start anything', async () => {
    const k = kit();
    const other = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi'));
    const port = await new Promise<number>((resolve) => other.listen(0, '127.0.0.1', () => resolve((other.address() as net.AddressInfo).port)));
    try {
      const l = launch(k, { MIMIC_PORT: String(port) });
      expect(await exited(l.proc, 20000)).toBe(1);
      expect(l.out()).toMatch(/Something other than Mimic is already using port/);
      expect(l.out()).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      expect(opened(k)).toBe('');
    } finally {
      other.close();
    }
  }, 40000);

  it('still opens the browser when the server is slow to start (a busy Mac), instead of staying blank for ever', async () => {
    const k = kit({ slowStart: 11 });
    const port = await freePort();
    const l = launch(k, { MIMIC_PORT: String(port) });
    expect(await waitUntil(() => l.out().includes('Starting Mimic'), 5000), 'it says it is starting at once').toBe(true);
    expect(opened(k)).toBe('');
    expect(await waitUntil(() => opened(k).includes(`http://localhost:${port}/`), 30000), l.out()).toBe(true);
    expect(l.out()).toContain('Mimic Vocal Coach is running');
    expect(l.out()).toMatch(/Still starting/);
    process.kill(-(l.proc.pid as number), 'SIGINT');
    expect(await exited(l.proc, 8000)).toBe(0);
  }, 60000);

  it('two quick double-clicks: one runs Mimic, the other just opens it and does not show an error', async () => {
    const k = kit();
    const port = await freePort();
    const a = launch(k, { MIMIC_PORT: String(port) });
    const b = launch(k, { MIMIC_PORT: String(port) });
    const winner = await Promise.race([exited(a.proc, 20000).then((c) => (c === null ? null : 'a')), exited(b.proc, 20000).then((c) => (c === null ? null : 'b'))]);
    expect(winner, 'exactly one of the two windows ends by itself').not.toBeNull();
    const loser = winner === 'a' ? a : b;
    const runner = winner === 'a' ? b : a;
    expect(loser.proc.exitCode).toBe(0);
    expect(loser.out()).toMatch(/already running/);
    expect(loser.out()).not.toMatch(/did not start|Press Return/);
    expect(loser.out()).not.toContain('Mimic Vocal Coach is running');
    expect(runner.out()).not.toMatch(/did not start/);
    expect(await waitUntil(() => runner.out().includes('Mimic Vocal Coach is running'), 15000), runner.out()).toBe(true);
    process.kill(-(runner.proc.pid as number), 'SIGINT');
    expect(await exited(runner.proc, 8000)).toBe(0);
  }, 60000);

  it('tells you when the Mimic that is already running was started from another folder', async () => {
    const first = kit();
    const second = kit();
    const port = await freePort();
    const a = launch(first, { MIMIC_PORT: String(port) });
    expect(await waitUntil(() => opened(first).includes(`:${port}/`), 15000), a.out()).toBe(true);
    const b = launch(second, { MIMIC_PORT: String(port) });
    expect(await exited(b.proc, 15000)).toBe(0);
    expect(b.out()).toMatch(/already running/);
    expect(b.out()).toMatch(/started from another folder/);
    expect(b.out()).toContain(realpathSync(join(first.root, 'app')));
    expect(opened(second)).toContain(`http://localhost:${port}/`);
    // the same folder twice gives no such note
    const c = launch(first, { MIMIC_PORT: String(port) });
    expect(await exited(c.proc, 15000)).toBe(0);
    expect(c.out()).toMatch(/already running/);
    expect(c.out()).not.toMatch(/another folder/);
    process.kill(-(a.proc.pid as number), 'SIGINT');
    expect(await exited(a.proc, 8000)).toBe(0);
  }, 60000);

  it('prints no locale warning even when LANG names a locale this machine does not have', async () => {
    const k = kit();
    const port = await freePort();
    const l = launch(k, { MIMIC_PORT: String(port), LANG: 'en_DE.UTF-8', LC_ALL: '', LC_CTYPE: 'xx_XX.UTF-8' });
    expect(await waitUntil(() => opened(k).includes(`:${port}/`), 15000), l.out()).toBe(true);
    expect(l.out()).not.toMatch(/locale/i);
    process.kill(-(l.proc.pid as number), 'SIGINT');
    expect(await exited(l.proc, 8000)).toBe(0);
  }, 40000);

  it('says plainly what to do when there is no perl, and does not point at a fallback that does not exist', async () => {
    const k = kit();
    // a copy that looks for perl where there is none; PATH has only dirname (the launcher's first need)
    const here = join(k.root, 'Start Mimic.command');
    writeFileSync(here, readFileSync(here, 'utf8').replace('-x /usr/bin/perl', '-x /nonexistent/perl'));
    const bin = join(k.root, '..', 'nobin');
    mkdirSync(bin);
    const dn = spawnSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(dn, join(bin, 'dirname'));
    const l = launch({ ...k, env: { ...k.env, PATH: bin } }, { MIMIC_PORT: '47398' });
    expect(await exited(l.proc, 10000)).toBe(1);
    expect(l.out()).toMatch(/no "perl"/);
    expect(l.out()).toMatch(/command line developer tools/);
    expect(l.out()).not.toMatch(/another way to start/);
    expect(opened(k)).toBe('');
  });

  it('explains a launcher that was moved away from its files', async () => {
    const k = kit({ withApp: false });
    const l = launch(k, { MIMIC_PORT: '47399' });
    expect(await exited(l.proc, 10000)).toBe(1);
    expect(l.out()).toMatch(/cannot find its files next to this launcher/);
    expect(l.out()).toMatch(/server\.pl/);
    expect(opened(k)).toBe('');
  });

  it('rejects a MIMIC_PORT that is not a number', async () => {
    const k = kit();
    const l = launch(k, { MIMIC_PORT: 'abc' });
    expect(await exited(l.proc, 10000)).toBe(1);
    expect(l.out()).toMatch(/MIMIC_PORT must be a number/);
  });
});

describe.skipIf(process.platform === 'win32')('scripts/make-mac-bundle.mjs checks what the launcher and server rely on', () => {
  /** A throwaway project with a tiny `dist/`, and a copy of the real script and mac/ files. */
  function project(over: { manifest?: string; index?: string } = {}) {
    const dir = mkdtempSync(join(scratch, 'proj-'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    copyFileSync(join(import.meta.dirname, 'make-mac-bundle.mjs'), join(dir, 'scripts', 'make-mac-bundle.mjs'));
    mkdirSync(join(dir, 'mac'));
    for (const f of ['server.pl', 'Start Mimic.command', 'README.txt']) copyFileSync(join(macDir, f), join(dir, 'mac', f));
    writeFileSync(join(dir, 'dist', 'sw.js'), 'x');
    writeFileSync(join(dir, 'dist', 'assets', 'index-1.js'), 'x');
    writeFileSync(join(dir, 'dist', 'manifest.webmanifest'), over.manifest ?? '{"name":"Mimic Vocal Coach"}');
    writeFileSync(join(dir, 'dist', 'index.html'), over.index ?? '<!doctype html><link rel="manifest" href="./manifest.webmanifest"><script type="module" src="./assets/index-1.js"></script>');
    return dir;
  }
  const run = (dir: string) => spawnSync(process.execPath, [join(dir, 'scripts', 'make-mac-bundle.mjs')], { encoding: 'utf8', timeout: 30000 });

  it.skipIf(!have('zip', ['-v']))('builds from a plain build (and only warns that the vocal-isolation model is absent)', () => {
    const r = run(project());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/vocal isolation:\s+NOT usable/);
  });

  it('refuses a build whose manifest no longer carries the name the launcher looks for', () => {
    const r = run(project({ manifest: '{"name":"Something else"}' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Mimic Vocal Coach/);
  });

  it('refuses a page that loads a script from the internet, or one the server could not find', () => {
    const external = run(project({ index: '<script type="module" src="https://cdn.example.com/x.js"></script>' }));
    expect(external.status).toBe(1);
    expect(external.stderr).toMatch(/from the internet/);
    const lost = run(project({ index: '<script type="module" src="index-1.js"></script>' }));
    expect(lost.status).toBe(1);
    expect(lost.stderr).toMatch(/no script under \.\/assets\//);
  });
});
