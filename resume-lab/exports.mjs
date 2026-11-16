import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDraft } from './core.mjs';
import { pythonExecutable } from './uploads.mjs';

const helper = fileURLToPath(new URL('./export_resume.py', import.meta.url));

export async function exportResume(value) {
  if (!value || !['docx', 'pdf'].includes(value.format) || value.reviewed !== true) throw new Error('Review the resume and choose Word or PDF.');
  if (typeof value.source !== 'string' || value.source.length < 100 || value.source.length > 45000) throw new Error('Provide the source resume for export checks.');
  const checks = await checkDraft(value.source, value.result);
  if (!checks.passed) throw new Error('Source checks found issues. Review the Evidence & gaps tab before exporting.');
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), ['-I', '-B', helper, value.format], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Document export needs Python 3 with python-docx and reportlab. See the Resume Lab README.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > 8 * 1024 * 1024) reject(new Error('The resume could not be exported. Check the document dependencies or shorten the draft.'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(JSON.stringify({ markdown: value.result.resume_markdown }));
  });
  if (value.format === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-' || value.format === 'docx' && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('Document export returned an invalid file.');
  return { bytes, filename: `tailored-resume.${value.format}`, contentType: value.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
}
