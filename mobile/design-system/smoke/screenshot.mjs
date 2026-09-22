import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

const server = http.createServer((req, res) => {
  const filePath = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 560, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
await page.goto(`http://127.0.0.1:${port}/smoke/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(dir, 'screenshot.png') });
await browser.close();
server.close();

if (errors.length) {
  console.error('Page errors:', errors);
  process.exit(1);
}
console.log('OK - screenshot.png written');
