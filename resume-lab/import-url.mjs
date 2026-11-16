import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isBlockedAddress } from '../providers/_ip-guard.mjs';
import { extractUpload, MAX_UPLOAD_BYTES, pythonExecutable } from './uploads.mjs';

const helper = fileURLToPath(new URL('./read_webpage.py', import.meta.url));

export function validatePublicURL(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Enter a public HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete URL starting with https://.'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) throw new Error('Use a public HTTPS URL with no username, password, or custom port.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((!host.includes('.') && !isIP(host)) || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) || (isIP(host) && isBlockedAddress(host))) throw new Error('Local, private, and internal addresses cannot be imported. Upload the file or paste its text instead.');
  url.hash = '';
  return url;
}

export function publicLookup(hostname, options, callback, resolve = lookup) {
  resolve(hostname, { all: true, family: options?.family || 0 }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) return callback(new Error('This URL resolves to a private or internal address.'));
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function getURL(url, deadline) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false, lookup: publicLookup, headers: { 'User-Agent': 'ResumeLab/1.0 (public document text import)', Accept: 'text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown', 'Accept-Encoding': 'identity' } }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.resume();
        return resolve({ redirect: response.headers.location, status });
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`The page returned HTTP ${status}. It may be unavailable or require login. Upload a file or paste the text instead.`));
      }
      if (Number(response.headers['content-length']) > MAX_UPLOAD_BYTES) { response.destroy(); return reject(new Error('The URL returns a file larger than 8 MB.')); }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); return reject(new Error('This server requires compressed downloads. Upload its document or paste the text instead.')); }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) { req.destroy(); reject(new Error('The URL returns more than 8 MB of content.')); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0].toLowerCase() }));
    });
    const timer = setTimeout(() => req.destroy(new Error('URL import timed out. Upload the file or paste its text instead.')), Math.max(1, deadline - Date.now()));
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

function readWebpage(bytes, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), ['-I', '-B', helper, target], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 350000) child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Web-page extraction needs Python 3.')); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('The page could not be read within the extraction limit. Paste its text instead.');
        const result = JSON.parse(output);
        if (result.error) throw new Error(result.error);
        resolve(result.text);
      } catch (error) { reject(error); }
    });
    child.stdin.end(bytes);
  });
}

export async function decodeURLContent({ bytes, contentType, url, target }) {
  const extension = extname(new URL(url).pathname).toLowerCase();
  let fileExtension;
  if (contentType === 'application/pdf' || bytes.subarray(0, 5).toString() === '%PDF-') fileExtension = '.pdf';
  else if (contentType.includes('wordprocessingml') || (extension === '.docx' && bytes.subarray(0, 2).toString() === 'PK')) fileExtension = '.docx';
  else if (['text/html', 'application/xhtml+xml'].includes(contentType) || (!contentType && /^\s*<(?:!doctype|html)/i.test(bytes.subarray(0, 300).toString()))) {
    const text = String(await readWebpage(bytes, target)).trim();
    const max = target === 'job' ? 25000 : 45000;
    if (text.length < 100) throw new Error('The page has too little readable text. It may require JavaScript or login. Upload a file or paste its text instead.');
    if (text.length < 2000 && /sign in to (?:view|continue)|log in to continue|verify (?:that )?you are human|enable javascript|access denied|checking your browser|complete the captcha/i.test(text)) throw new Error('This page appears to require login, JavaScript, or a human verification step. Upload a file or paste its text instead.');
    if (text.length > max) throw new Error(`The page contains more than ${max.toLocaleString()} characters. Paste only the relevant text instead.`);
    return { text, target, characters: text.length };
  } else if (contentType.startsWith('text/') || ['.txt', '.md'].includes(extension)) fileExtension = '.txt';
  else throw new Error('This URL does not return a supported web page, PDF, DOCX, or text document.');
  return extractUpload({ target, filename: `url-document${fileExtension}`, content: bytes.toString('base64') });
}

export async function importURL(value, { fetchURL = getURL } = {}) {
  if (!value || !['job', 'source'].includes(value.target)) throw new Error('Choose a job description or resume URL.');
  let url = validatePublicURL(value.url);
  const googleDoc = url.hostname === 'docs.google.com' && url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (googleDoc) url = new URL(`https://docs.google.com/document/d/${googleDoc[1]}/export?format=txt`);
  const deadline = Date.now() + 20000;
  for (let hop = 0; hop <= 3; hop++) {
    url = validatePublicURL(url.href);
    const response = await fetchURL(url, deadline);
    if (response.redirect !== undefined || response.status >= 300 && response.status < 400) {
      if (!response.redirect || hop === 3) throw new Error('This URL redirects too many times or has no usable destination.');
      url = validatePublicURL(new URL(response.redirect, url).href);
      continue;
    }
    const content = await decodeURLContent({ ...response, url: url.href, target: value.target });
    return { ...content, url: url.href, host: url.hostname, warning: 'Imported text is unverified. Review it before generation. Importing does not call Codex.' };
  }
}
