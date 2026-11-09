'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { startBackend } = require('../railway-xray/backend');

function fixture(t, source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-xray-backend-test-'));
    const binaryPath = path.join(directory, 'backend');
    fs.writeFileSync(binaryPath, `#!${process.execPath}\n'use strict';\nconst fs = require('node:fs');\nconst directory = ${JSON.stringify(directory)};\n${source}\n`, { mode: 0o700 });
    let backend;
    t.after(async () => {
        if (backend) await backend.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
        directory,
        start(onFailure = () => {}, config = {}) {
            backend = startBackend({ backendPort: 8081, binaryPath, ...config }, onFailure);
            return backend;
        },
    };
}

async function readWhenReady(filename) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try {
            return fs.readFileSync(filename, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await delay(10);
    }
    assert.fail(`Timed out waiting for ${filename}`);
}

function waitForClose(child) {
    return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
}

function assertReaped(pid) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('child receives only the seven allowed environment variables without changing the parent environment', { timeout: 10000 }, async t => {
    const additions = {
        uuid: 'private-vless-credential',
        UUID: 'another-private-credential',
        TROJAN_PASSWORD: 'private-trojan-credential',
        CLOUDFLARE_TUNNEL_TOKEN: 'private-cloudflare-token',
        REVERSE_PRX_TARGET: 'https://parent-only.example',
        PATH_VLESS: '/parent-path',
    };
    const original = Object.fromEntries(Object.keys(additions).map(key => [key, process.env[key]]));
    Object.assign(process.env, additions);
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const parentEnvironment = { ...process.env };
    const program = fixture(t, `
fs.writeFileSync(directory + '/environment.json', JSON.stringify(process.env));
setInterval(() => {}, 1000);
`);
    const failures = [];
    const backend = program.start(error => failures.push(error), { backendPort: 9191 });
    const environment = JSON.parse(await readWhenReady(path.join(program.directory, 'environment.json')));
    assert.deepEqual(environment, {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        PORT: '9191',
        PATH_VLESS: '/vless',
        PATH_TROJAN: '/trojan',
        PATH_VMESS: '/vmess',
        PATH_SS: '/ss',
        REVERSE_PRX_TARGET: '',
    });
    assert.deepEqual({ ...process.env }, parentEnvironment);
    await backend.stop();
    assert.deepEqual(failures, []);
});

test('unexpected exit code zero reports one failure', { timeout: 10000 }, async t => {
    const program = fixture(t, 'process.exit(0);');
    const failures = [];
    const backend = program.start(error => failures.push(error));
    const result = await waitForClose(backend.child);
    assert.equal(result.code, 0);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof Error);
    assert.match(failures[0].message, /0/);
    await backend.stop();
    assert.equal(failures.length, 1);
    assertReaped(backend.child.pid);
});

test('spawn ENOENT reports one failure and stop still resolves', { timeout: 10000 }, async t => {
    const program = fixture(t, 'process.exit(0);');
    const failures = [];
    const backend = program.start(error => failures.push(error), {
        binaryPath: path.join(program.directory, 'does-not-exist'),
    });
    await waitForClose(backend.child);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof Error);
    assert.equal(failures[0].code, 'ENOENT');
    await backend.stop();
    await backend.stop();
    assert.equal(failures.length, 1);
});

test('XRAY_BINARY supplies the executable when binaryPath is omitted', { timeout: 10000 }, async t => {
    const program = fixture(t, `
fs.writeFileSync(directory + '/ready', 'ready');
setInterval(() => {}, 1000);
`);
    const previous = process.env.XRAY_BINARY;
    process.env.XRAY_BINARY = path.join(program.directory, 'backend');
    t.after(() => {
        if (previous === undefined) delete process.env.XRAY_BINARY;
        else process.env.XRAY_BINARY = previous;
    });
    const failures = [];
    const backend = program.start(error => failures.push(error), { binaryPath: undefined });
    await readWhenReady(path.join(program.directory, 'ready'));
    await backend.stop();
    assert.deepEqual(failures, []);
    assertReaped(backend.child.pid);
});

test('immediate stop suppresses a pending spawn failure', { timeout: 10000 }, async t => {
    const program = fixture(t, 'process.exit(0);');
    const failures = [];
    const backend = program.start(error => failures.push(error), {
        binaryPath: path.join(program.directory, 'does-not-exist'),
    });
    await backend.stop();
    assert.deepEqual(failures, []);
});

test('concurrent and repeated stop sends one SIGTERM and waits until the process is reaped', { timeout: 10000 }, async t => {
    const program = fixture(t, `
process.on('SIGTERM', () => {
    fs.appendFileSync(directory + '/signals', 'SIGTERM\\n');
    setTimeout(() => process.exit(0), 50);
});
fs.writeFileSync(directory + '/ready', 'ready');
setInterval(() => {}, 1000);
`);
    const failures = [];
    const backend = program.start(error => failures.push(error));
    await readWhenReady(path.join(program.directory, 'ready'));
    let closed = false;
    backend.child.once('close', () => { closed = true; });
    await Promise.all([backend.stop(), backend.stop()]);
    assert.equal(closed, true);
    assert.equal(fs.readFileSync(path.join(program.directory, 'signals'), 'utf8'), 'SIGTERM\n');
    assert.deepEqual(failures, []);
    assertReaped(backend.child.pid);
    await backend.stop();
    assert.deepEqual(failures, []);
});

test('stop escalates an ignored SIGTERM to SIGKILL after five seconds and reaps the process', { timeout: 12000 }, async t => {
    const program = fixture(t, `
process.on('SIGTERM', () => {
    fs.writeFileSync(directory + '/term', 'SIGTERM');
});
fs.writeFileSync(directory + '/ready', 'ready');
setInterval(() => {}, 1000);
`);
    const failures = [];
    const backend = program.start(error => failures.push(error));
    await readWhenReady(path.join(program.directory, 'ready'));
    const closed = waitForClose(backend.child);
    const started = Date.now();
    await backend.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4900, `SIGKILL happened too early: ${elapsed}ms`);
    assert.ok(elapsed < 10000, `stop did not stay bounded: ${elapsed}ms`);
    assert.equal(fs.readFileSync(path.join(program.directory, 'term'), 'utf8'), 'SIGTERM');
    assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(failures, []);
    assertReaped(backend.child.pid);
});
