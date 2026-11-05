const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../scripts/manage.js');
function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-xray-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function run(cwd, args, envFile = false) {
    return spawnSync(process.execPath, [...(envFile ? ['--env-file=.env'] : []), cli, ...args], {
        cwd, encoding: 'utf8', env: { PATH: process.env.PATH },
    });
}

test('init creates private credentials once, without logging their values', t => {
    const cwd = workspace(t);
    const result = run(cwd, ['init', '203.0.113.10', 'www.example.com', 'phone', 'laptop']);
    assert.equal(result.status, 0, result.stderr);
    const contents = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
    assert.match(contents, /REALITY_PRIVATE_KEY=[A-Za-z0-9_-]{43}/);
    assert.match(contents, /REALITY_SHORT_ID=[0-9a-f]{16}/);
    assert.equal(fs.statSync(path.join(cwd, '.env')).mode & 0o777, 0o600);
    const { parseEnv } = require('node:util');
    const env = parseEnv(contents);
    assert.ok(!(result.stdout + result.stderr).includes(env.REALITY_PRIVATE_KEY));
    const second = run(cwd, ['init', '203.0.113.11', 'www.example.com']);
    assert.notEqual(second.status, 0);
    assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), contents);
});

test('server/export generate private files, isolate devices and refuse overwrite', t => {
    const cwd = workspace(t);
    assert.equal(run(cwd, ['init', '203.0.113.10', 'www.example.com', 'phone', 'laptop']).status, 0);
    const server = run(cwd, ['server', 'server.json'], true);
    assert.equal(server.status, 0, server.stderr);
    assert.equal(fs.statSync(path.join(cwd, 'server.json')).mode & 0o777, 0o600);
    const exported = run(cwd, ['export', 'clients'], true);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(fs.statSync(path.join(cwd, 'clients')).mode & 0o777, 0o700);
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'server.json')));
    const key = config.inbounds[0].streamSettings.realitySettings.privateKey;
    const clients = config.inbounds[0].settings.clients;
    for (const name of ['phone', 'laptop']) {
        for (const suffix of ['mihomo.yaml', 'vless.txt']) {
            const file = path.join(cwd, 'clients', `${name}.${suffix}`);
            const contents = fs.readFileSync(file, 'utf8');
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            assert.ok(!contents.includes(key));
            const other = clients.find(c => c.email !== name);
            assert.ok(!contents.includes(other.id));
        }
    }
    assert.notEqual(run(cwd, ['export', 'clients'], true).status, 0);
    assert.notEqual(run(cwd, ['server', 'server.json'], true).status, 0);
    assert.ok(!(server.stdout + server.stderr + exported.stdout + exported.stderr).includes(key));
});

test('invalid configuration fails without creating output or echoing secrets', t => {
    const cwd = workspace(t);
    const result = spawnSync(process.execPath, [cli, 'server', 'server.json'], {
        cwd, encoding: 'utf8', env: { REALITY_PRIVATE_KEY: 'do-not-log-this-secret' },
    });
    assert.notEqual(result.status, 0);
    assert.ok(!fs.existsSync(path.join(cwd, 'server.json')));
    assert.ok(!(result.stdout + result.stderr).includes('do-not-log-this-secret'));
});
