// Simple log server - Run with: node logServer.js
// Then open testBundle.html in browser
// Logs will be written to debug.log

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'debug.log');
const PORT = 9999;

// Clear log file on startup
fs.writeFileSync(LOG_FILE, `=== Debug Log Started: ${new Date().toISOString()} ===\n\n`);

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const timestamp = new Date().toISOString().substr(11, 12);
                const line = `[${timestamp}] ${data.msg}\n`;
                fs.appendFileSync(LOG_FILE, line);
                res.writeHead(200);
                res.end('ok');
            } catch (e) {
                res.writeHead(400);
                res.end('bad request');
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/clear') {
        fs.writeFileSync(LOG_FILE, `=== Log Cleared: ${new Date().toISOString()} ===\n\n`);
        res.writeHead(200);
        res.end('cleared');
        return;
    }

    res.writeHead(404);
    res.end('not found');
});

server.listen(PORT, () => {
    console.log(`Log server running on http://localhost:${PORT}`);
    console.log(`Logs will be written to: ${LOG_FILE}`);
    console.log('Press Ctrl+C to stop');
});
