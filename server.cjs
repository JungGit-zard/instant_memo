const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.MEMO_PORT || 5178);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function getLanAddresses() {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((item) => item && item.family === 'IPv4' && !item.internal)
        .map((item) => item.address)
        .filter((address) => !address.startsWith('127.'))
        .sort((left, right) => {
            const score = (address) => {
                if (address.startsWith('192.168.')) return 0;
                if (address.startsWith('10.')) return 1;
                if (address.startsWith('172.')) return 2;
                return 3;
            };
            return score(left) - score(right) || left.localeCompare(right);
        });
}

function sendJson(response, payload) {
    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache'
    });
    response.end(JSON.stringify(payload));
}

function handleSyncInfo(request, response, url) {
    const namespace = url.searchParams.get('ns') || '';
    const query = namespace ? `?ns=${encodeURIComponent(namespace)}` : '';
    const host = request.headers.host || `127.0.0.1:${PORT}`;
    const currentOrigin = `http://${host}`;
    const lanUrls = getLanAddresses().map((address) => `http://${address}:${PORT}/${query}`);
    const urls = host.startsWith('127.') || host.startsWith('localhost')
        ? lanUrls
        : [`${currentOrigin}/${query}`, ...lanUrls];

    sendJson(response, {
        namespace,
        port: PORT,
        urls: Array.from(new Set(urls))
    });
}

function serveStatic(request, response, url) {
    const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(ROOT, requestedPath));

    if (!filePath.startsWith(ROOT)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache'
        });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        response.end(data);
    });
}

function createServer() {
    return http.createServer((request, response) => {
        const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${PORT}`}`);

        if (request.method === 'GET' && url.pathname === '/sync-info') {
            handleSyncInfo(request, response, url);
            return;
        }

        if (request.method === 'GET' || request.method === 'HEAD') {
            serveStatic(request, response, url);
            return;
        }

        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method not allowed');
    });
}

if (require.main === module) {
    createServer().listen(PORT, '0.0.0.0', () => {
        console.log(`Instant Memo running at http://127.0.0.1:${PORT}`);
        getLanAddresses().forEach((address) => {
            console.log(`Mobile URL: http://${address}:${PORT}`);
        });
    });
}

module.exports = {
    createServer,
    getLanAddresses
};
