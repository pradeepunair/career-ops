import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { MODEL, UPSTREAM, validateInput, checkDraft, runCodex } from './core.mjs';
import { extractUpload, MAX_UPLOAD_BODY_BYTES } from './uploads.mjs';
import { importURL } from './import-url.mjs';
import { exportResume } from './exports.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const key = randomBytes(32).toString('hex');
const dashboardOrigins = new Set(['http://127.0.0.1:8501', 'http://localhost:8501']);

export function allowedRequest(req, origin) {
  return req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin) && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
}

export function allowedDashboardFrame(req, origin) {
  if (req.method !== 'GET' || req.headers.host !== new URL(origin).host || req.headers['sec-fetch-dest'] !== 'iframe') return false;
  try {
    const parent = new URL(req.headers.referer).origin;
    return new URL(req.url, origin).pathname === '/' && dashboardOrigins.has(parent) && (!req.headers.origin || req.headers.origin === parent);
  } catch {
    return false;
  }
}

function tokenMatches(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(key));
}

async function jsonBody(req, maxBytes = 250000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Use an application/json request.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Input is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createLabServer({ generate = runCodex, sourcePath = join(getCareerOpsRoot(), 'cv.md'), loadTrial = true, persistTrial = true } = {}) {
  let origin;
  let busy = false;
  let extracting = false;
  let activeController;
  let last = null;
  const privateDir = join(here, '.local');
  const server = createServer(async (req, res) => {
    if (!origin) origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${[...dashboardOrigins].join(' ')}` };
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    const send = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!allowedRequest(req, origin) && !allowedDashboardFrame(req, origin)) return send(403, { error: 'Only this local page can access the trial.' });
    const path = new URL(req.url, origin).pathname;
    try {
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(join(here, 'public/index.html')));
      }
      if (req.method === 'GET' && path === '/api/session') {
        let source = '';
        try { source = await readFile(sourcePath, 'utf8'); } catch { /* Pasting a source resume is supported without cv.md. */ }
        return send(200, { token: key, source, source_label: source ? 'Your local cv.md' : 'Paste your current resume', model: MODEL, upstream: UPSTREAM, mode: 'draft-only' });
      }
      if (!tokenMatches(req.headers['x-lab-token'])) return send(403, { error: 'Refresh the local page to start a session.' });
      if (req.method === 'POST' && path === '/api/import-url') {
        if (busy || extracting) return send(409, { error: 'Wait for the current generation or import to finish.' });
        extracting = true;
        try {
          return send(200, await importURL(await jsonBody(req, 12000)));
        } finally {
          extracting = false;
        }
      }
      if (req.method === 'POST' && path === '/api/export') {
        const artifact = await exportResume(await jsonBody(req));
        res.writeHead(200, { 'Content-Type': artifact.contentType, 'Content-Disposition': `attachment; filename="${artifact.filename}"`, 'Content-Length': artifact.bytes.length });
        return res.end(artifact.bytes);
      }
      if (req.method === 'POST' && path === '/api/upload') {
        if (busy || extracting) return send(409, { error: 'Wait for the current generation or file upload to finish.' });
        extracting = true;
        try {
          return send(200, await extractUpload(await jsonBody(req, MAX_UPLOAD_BODY_BYTES)));
        } finally {
          extracting = false;
        }
      }
      if (req.method === 'GET' && path === '/api/trial') {
        if (!last && loadTrial) {
          try { last = JSON.parse(await readFile(join(privateDir, 'trial.json'), 'utf8')); } catch { /* No saved trial is a valid first run. */ }
        }
        return send(200, { trial: last });
      }
      if (req.method === 'POST' && path === '/api/cancel') {
        activeController?.abort();
        return send(200, { cancelled: true });
      }
      if (req.method === 'POST' && path === '/api/generate') {
        if (busy) return send(409, { error: 'One job is already running. Wait or cancel it.' });
        const input = validateInput(await jsonBody(req));
        busy = true;
        activeController = new AbortController();
        const cancelOnClose = () => { if (!res.writableEnded) activeController?.abort(); };
        res.once('close', cancelOnClose);
        try {
          const value = await generate(input.source, input.job, { signal: activeController.signal });
          last = { ...value, input };
          if (persistTrial) {
            await mkdir(privateDir, { recursive: true, mode: 0o700 });
            await writeFile(join(privateDir, 'trial.json'), JSON.stringify(last, null, 2), { mode: 0o600 });
          }
          return send(200, last);
        } finally {
          busy = false; activeController = null; res.off('close', cancelOnClose);
        }
      }
      if (req.method === 'POST' && path === '/api/check') {
        const body = await jsonBody(req);
        if (typeof body.source !== 'string' || body.source.length > 45000) throw new Error('Provide the source resume.');
        return send(200, { checks: await checkDraft(body.source, body.result) });
      }
      return send(404, { error: 'This trial has no application submission endpoint.' });
    } catch (error) {
      return send(400, { error: error.message || 'The request could not finish.' });
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  server.on('close', () => activeController?.abort());
  return server;
}

if (isMainModule(import.meta.url)) {
  const port = Number(process.env.RESUME_LAB_PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  const server = createLabServer();
  server.listen(port, '127.0.0.1', () => console.log(`Resume Lab: http://127.0.0.1:${port}\nCodex model: ${MODEL}\nDraft-only. No employer requests or application submission.`));
  process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
}
