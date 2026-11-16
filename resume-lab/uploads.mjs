import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4096;
const helper = fileURLToPath(new URL('./extract_upload.py', import.meta.url));
const supported = new Set(['.pdf', '.docx', '.txt', '.md']);

function pythonExecutable() {
  if (process.env.RESUME_LAB_PYTHON) return process.env.RESUME_LAB_PYTHON;
  const candidates = [fileURLToPath(new URL('./.local/venv/bin/python3', import.meta.url)), join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')];
  return candidates.find(path => existsSync(path)) || 'python3';
}

function readDocument(bytes, extension) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), ['-I', '-B', helper, extension], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 350000) { exceeded = true; child.kill('SIGKILL'); }
    });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Document extraction needs Python 3. Set RESUME_LAB_PYTHON to your Python executable.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Document extraction timed out. Upload a simpler file or paste its text.'));
      if (exceeded || code !== 0) return reject(new Error('This document could not be read within the extraction limits. Try a smaller file or paste its text.'));
      try {
        const result = JSON.parse(output);
        if (result.error) throw new Error(result.error);
        if (typeof result.text !== 'string') throw new Error('Document extraction did not return text.');
        resolve(result.text);
      } catch (error) { reject(error); }
    });
    child.stdin.end(bytes);
  });
}

export async function extractUpload(value) {
  if (!value || !['job', 'source'].includes(value.target)) throw new Error('Choose a job description or resume upload.');
  if (typeof value.filename !== 'string' || !value.filename || value.filename.length > 255) throw new Error('Choose a file with a valid filename.');
  const extension = extname(value.filename).toLowerCase();
  if (!supported.has(extension)) throw new Error('Use a PDF, DOCX, TXT, or Markdown file.');
  if (typeof value.content !== 'string' || !value.content.length || value.content.length > MAX_UPLOAD_BODY_BYTES - 4096 || value.content.length % 4 || /[^A-Za-z0-9+/=]/.test(value.content)) throw new Error('The uploaded file is empty, too large, or not encoded correctly.');
  const bytes = Buffer.from(value.content, 'base64');
  if (bytes.toString('base64') !== value.content) throw new Error('The uploaded file is not encoded correctly.');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error('Use a file of 8 MB or less.');
  let text;
  if (extension === '.txt' || extension === '.md') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Save text and Markdown files as UTF-8, or paste their text.'); }
  } else {
    text = await readDocument(bytes, extension);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(extension === '.pdf' ? 'No selectable text was found. This may be a scanned PDF. Use a text-based PDF, DOCX, or paste text obtained with OCR.' : 'No readable text was found in this file.');
  const limit = value.target === 'job' ? 25000 : 45000;
  if (text.length > limit) throw new Error(`Extracted text exceeds the ${limit.toLocaleString()}-character limit. Upload a shorter document or paste only the relevant text.`);
  return { text, target: value.target, filename: value.filename.split(/[\\/]/).pop(), characters: text.length, warning: 'Review the extracted text for missing content or reading-order errors before generating. Uploading does not call Codex.' };
}
