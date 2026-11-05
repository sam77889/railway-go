#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { ConfigError, readConfig, buildServerConfig, buildClientConfig, buildVlessLink } = require('../lib/config');

function writePrivate(file, contents) {
    // O_EXCL also refuses symlinks and prevents accidental key rotation/overwrite.
    fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
}

function main(args) {
    const [command, ...values] = args;
    if (command === 'init' && values.length >= 2) {
        const [address, serverName, ...names] = values;
        const { privateKey } = generateKeyPairSync('x25519');
        const env = {
            SERVER_ADDRESS: address, SERVER_PORT: '443', REALITY_SERVER_NAME: serverName,
            REALITY_PRIVATE_KEY: privateKey.export({ format: 'jwk' }).d,
            REALITY_SHORT_ID: randomBytes(8).toString('hex'),
            VLESS_CLIENTS: JSON.stringify((names.length ? names : ['phone']).map(name => ({ name, id: randomUUID() }))),
        };
        readConfig(env);
        writePrivate('.env', Object.entries(env).map(([key, value]) =>
            `${key}=${key === 'VLESS_CLIENTS' ? `'${value}'` : value}`).join('\n') + '\n');
        console.log('Created .env (0600). Keep this file private and back it up securely.');
        return;
    }
    if ((command === 'server' || command === 'export') && values.length === 1) {
        const config = readConfig(process.env);
        if (command === 'server') {
            writePrivate(values[0], JSON.stringify(buildServerConfig(config), null, 2) + '\n');
            console.log('Server configuration generated.');
        } else {
            fs.mkdirSync(values[0], { mode: 0o700 });
            for (const client of config.clients) {
                writePrivate(path.join(values[0], `${client.name}.vless.txt`), buildVlessLink(config, client) + '\n');
                // JSON is a YAML 1.2 subset, accepted by Mihomo without an extra serializer.
                writePrivate(path.join(values[0], `${client.name}.mihomo.yaml`),
                    JSON.stringify(buildClientConfig(config, client), null, 2) + '\n');
            }
            console.log('Client files exported (directory 0700, files 0600). Treat them as credentials.');
        }
        return;
    }
    throw new ConfigError('Usage: manage.js init SERVER_ADDRESS REALITY_SERVER_NAME [device ...] | server FILE | export NEW_DIRECTORY');
}

try {
    main(process.argv.slice(2));
} catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    else if (error.code === 'EEXIST') console.error('Output already exists; refusing to overwrite.');
    else console.error('Operation failed; check input and output file permissions.');
    process.exitCode = 1;
}
