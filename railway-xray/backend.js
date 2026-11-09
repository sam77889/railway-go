'use strict';

const { spawn } = require('node:child_process');

function startBackend(config, onFailure) {
    const child = spawn(config.binaryPath || process.env.XRAY_BINARY || '/usr/local/bin/railway-xray', [], {
        env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            PORT: String(config.backendPort),
            PATH_VLESS: '/vless',
            PATH_TROJAN: '/trojan',
            PATH_VMESS: '/vmess',
            PATH_SS: '/ss',
            REVERSE_PRX_TARGET: '',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    let stopping = false;
    let failureReported = false;
    let closed = false;
    let stopPromise;
    let killTimer;
    let resolveClose;
    const closePromise = new Promise(resolve => { resolveClose = resolve; });

    function reportFailure(error) {
        if (stopping || failureReported) return;
        failureReported = true;
        onFailure(error);
    }

    child.on('error', reportFailure);
    child.on('exit', (code, signal) => {
        reportFailure(new Error(`Railway Xray backend exited unexpectedly (code ${code}, signal ${signal || 'none'})`));
    });
    child.once('close', () => {
        closed = true;
        clearTimeout(killTimer);
        resolveClose();
    });

    function stop() {
        if (stopPromise) return stopPromise;
        stopping = true;
        stopPromise = closePromise;
        if (!closed) {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
                if (!closed) child.kill('SIGKILL');
            }, 5000);
        }
        return stopPromise;
    }

    return { stop, child };
}

module.exports = { startBackend };
