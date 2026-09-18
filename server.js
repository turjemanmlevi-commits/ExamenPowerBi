// Local: node server.js -> http://localhost:5500. On Vercel the exported handler serves every route (see vercel.json).
// Serves the cheat sheet and proxies the "Messages" section to the Claude API.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 5500;
const ROOT = __dirname;
const MAX_BODY = 45 * 1024 * 1024;
const SAMPLE_ROWS = 60;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ---------- .env (the API key lives here, never in the browser) ----------
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env yet */ }

const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// A public URL in front of a paid API key needs a gate: hosted deployments refuse to call Claude without APP_PASSWORD.
const HOSTED = Boolean(process.env.VERCEL);
const passwordOk = (req) => {
  const want = process.env.APP_PASSWORD;
  if (!want) return !HOSTED;
  const got = Buffer.from(String(req.headers['x-app-password'] || ''));
  return got.length === Buffer.byteLength(want) && crypto.timingSafeEqual(got, Buffer.from(want));
};

// ---------- system prompt: tutor role + the student's own notes ----------
function notesFromPage() {
  try {
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    html = (html.match(/<main[\s\S]*?<\/main>/) || [''])[0];
    html = html.replace(/<section id="messages"[\s\S]*?<\/section>/, '');
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
      .replace(/<\/(p|li|h1|h2|h3|tr|pre|div)>/g, '\n')
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/⟦(?:[tmqv]:)?([A-Za-z]+)⟧/g, '<$1>')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  } catch (e) { return ''; }
}

const SYSTEM = `You are a Power BI tutor helping a student practise for a Power BI Desktop exam (IEB). The student sends you the exercise brief and/or the data files (PDF, Word, Excel, CSV, screenshots) and wants the exercise solved with a click-by-click walkthrough they can follow in Power BI Desktop (English UI).

How to answer:
- Always answer in English, unless the student explicitly asks for another language.
- Work in the exam order: 1) Power Query cleaning, 2) Append/Merge if several files, 3) new columns, 4) Close & Apply, 5) Date table + Mark as date table + sort columns, 6) relationships, 7) _Measures table and measures, 8) visuals for each topic the brief asks for, 9) output polish (theme, slicers, page navigator, bookmarks, captions), 10) final checks.
- For every step say exactly where to click (Ribbon tab -> button -> option) and why it is needed, in one or two sentences.
- Use the REAL table and column names from the student's files. Never invent a column; if a name is not visible in what you received, say which name you assumed.
- For every relationship state it as: table[column] (1) -> table[column] (*), which side is unique and why, Single cross filter.
- Give all DAX and M as fenced code blocks (\`\`\`dax or \`\`\`m) ready to paste. ONE measure or ONE column formula per code block, because Power BI accepts one definition per paste. Quote table names that need it ('Date'), and use [#"Column name"] in M when a column name has symbols.
- Point out the traps you can see in the data: currency text in numeric columns, month columns that need Unpivot, text dates, nulls, duplicate IDs, mismatched key types, keys missing from a dimension (expected Blank).
- For each analysis topic in the brief, recommend the visual, the fields for each well, and a one-line caption that states a conclusion.
- Data files arrive as a SAMPLE (header plus the first ${SAMPLE_ROWS} rows, with the total row count). Do not compute totals from the sample; describe how to get them in Power BI instead. Excel dates may show up as serial numbers.
- Format: Markdown with short headings and numbered steps. Do not use Markdown tables. Be complete but not padded.

The student's own cheat sheet follows. Prefer its methods and naming (the _Measures table, DIVIDE instead of "/", DISTINCTCOUNT for orders, Left Outer merges, 1:* Single relationships, never many-to-many).

<student_notes>
${notesFromPage()}
</student_notes>`;

// ---------- minimal zip reader (for .docx / .xlsx) ----------
function openZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let k = 0; k < count && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    entries[name] = { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42) };
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return {
    names: Object.keys(entries),
    read(name) {
      const e = entries[name];
      if (!e) return null;
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const data = buf.subarray(start, start + e.size);
      return (e.method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    }
  };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function docxToText(buf) {
  const xml = openZip(buf).read('word/document.xml') || '';
  return unxml(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ').replace(/<[^>]+>/g, '')).trim();
}

function xlsxToText(buf) {
  const zip = openZip(buf);
  const strings = [];
  const ss = zip.read('xl/sharedStrings.xml') || '';
  ss.replace(/<si>([\s\S]*?)<\/si>/g, (m, inner) => {
    let t = '';
    inner.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (mm, txt) => { t += txt; return mm; });
    strings.push(unxml(t));
    return m;
  });
  const sheetNames = [];
  (zip.read('xl/workbook.xml') || '').replace(/<sheet\b[^>]*\bname="([^"]*)"/g, (m, n) => { sheetNames.push(unxml(n)); return m; });
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const out = [];
  sheets.forEach((file, idx) => {
    const xml = zip.read(file);
    const rows = xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];
    out.push(`--- Sheet "${sheetNames[idx] || idx + 1}": ${rows.length} rows in total, first ${Math.min(rows.length, SAMPLE_ROWS)} shown (tab-separated) ---`);
    rows.slice(0, SAMPLE_ROWS).forEach((row) => {
      const cells = [];
      row.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, attrs, inner) => {
        const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1] || '';
        let col = 0;
        for (const ch of ref) col = col * 26 + (ch.charCodeAt(0) - 64);
        const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
        let v = ((inner || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (type === 's' && v !== undefined) v = strings[Number(v)];
        else if (type === 'inlineStr') v = unxml(((inner || '').match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        else if (v !== undefined) v = unxml(v);
        cells[Math.max(col - 1, 0)] = v === undefined ? '' : v;
        return m;
      });
      out.push(Array.from(cells, (c) => (c === undefined ? '' : c)).join('\t'));
    });
  });
  return out.join('\n');
}

function csvToText(buf) {
  const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return `--- ${lines.length} lines in total (including header), first ${Math.min(lines.length, SAMPLE_ROWS + 1)} shown ---\n`
    + lines.slice(0, SAMPLE_ROWS + 1).join('\n');
}

// Browser sends {type:"file", name, data(base64)}; turn each into Claude content blocks.
function fileToBlocks(file) {
  const name = String(file.name || 'file');
  const ext = path.extname(name).toLowerCase();
  const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  if (images[ext]) {
    return [{ type: 'text', text: `Image: ${name}` },
      { type: 'image', source: { type: 'base64', media_type: images[ext], data: file.data } }];
  }
  if (ext === '.pdf') {
    return [{ type: 'document', title: name, source: { type: 'base64', media_type: 'application/pdf', data: file.data } }];
  }
  const buf = Buffer.from(file.data, 'base64');
  let text;
  if (ext === '.docx') text = docxToText(buf);
  else if (ext === '.xlsx' || ext === '.xlsm') text = xlsxToText(buf);
  else if (ext === '.csv' || ext === '.tsv') text = csvToText(buf);
  else if (['.txt', '.md', '.json', '.m', '.dax'].includes(ext)) text = buf.toString('utf8');
  else {
    const err = new Error(`"${name}": this file type cannot be read. Send PDF, Word (.docx), Excel (.xlsx), CSV, text or screenshots. A .pbix cannot be read - send screenshots of it instead.`);
    err.userFacing = true;
    throw err;
  }
  return [{ type: 'text', text: `<file name="${name}">\n${text}\n</file>` }];
}

function toApiMessages(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string'
      ? m.content
      : m.content.flatMap((b) => (b.type === 'file' ? fileToBlocks(b) : [{ type: 'text', text: String(b.text || '') }]))
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Files are too large (limit about 30 MB in total).'), { userFacing: true })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const KEY_HELP = HOSTED
  ? 'No valid API key. In Vercel open Project -> Settings -> Environment Variables, add ANTHROPIC_API_KEY, then redeploy.'
  : 'No valid API key. Open the file ".env" in this folder, paste your key after ANTHROPIC_API_KEY= , save, and restart the server (close the window and run start.bat again). Keys are created at console.anthropic.com -> API keys.';

async function handleMessages(req, res) {
  let stream;
  let started = false;
  try {
    if (HOSTED && !process.env.APP_PASSWORD) return sendJson(res, 503, { error: 'This deployment has no access password. In Vercel add the environment variable APP_PASSWORD and redeploy.' });
    if (!passwordOk(req)) return sendJson(res, 403, { error: 'Wrong or missing access password. Press Send again to retype it.', code: 'password' });
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.messages) || !body.messages.length) return sendJson(res, 400, { error: 'Empty conversation.' });
    const client = new Anthropic();
    stream = client.beta.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      messages: toApiMessages(body.messages)
    });
    res.on('close', () => { if (!res.writableEnded) stream.abort(); });
    stream.on('text', (delta) => {
      if (!started) {
        started = true;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      }
      res.write(delta);
    });
    const final = await stream.finalMessage();
    if (!started) res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (final.stop_reason === 'refusal') res.write('\n\n[Claude declined to answer this request.]');
    if (final.stop_reason === 'max_tokens') res.write('\n\n[The answer hit the length limit. Send "continue" to get the rest.]');
    res.end();
  } catch (err) {
    let status = 500;
    let msg = err && err.message ? err.message : String(err);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) { status = 401; msg = KEY_HELP; }
    else if (err instanceof Anthropic.RateLimitError) { status = 429; msg = 'Rate limited by the API. Wait a minute and send again.'; }
    else if (err instanceof Anthropic.BadRequestError) { status = 400; msg = 'The API rejected the request: ' + msg; }
    else if (err instanceof Anthropic.APIConnectionError) { status = 502; msg = 'Could not reach the Claude API. Check your internet connection.'; }
    else if (err instanceof Anthropic.APIError) { status = err.status || 500; msg = `API error ${status}: ${msg}`; }
    else if (err && err.userFacing) status = 400;
    else if (!hasKey()) { status = 401; msg = KEY_HELP; }
    if (res.writableEnded || res.destroyed) return;
    if (started) res.end(`\n\n[Error: ${msg}]`);
    else sendJson(res, status, { error: msg });
  }
}

function app(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/api/status') return sendJson(res, 200, { key: hasKey(), hosted: HOSTED, password: Boolean(process.env.APP_PASSWORD), model: 'claude-opus-5' });
  if (url === '/api/messages' && req.method === 'POST') return void handleMessages(req, res);

  let rel = decodeURIComponent(url);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const base = path.basename(file);
  if (!file.startsWith(ROOT) || base.startsWith('.') || file.includes('node_modules')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

module.exports = app;
Object.assign(app, { docxToText, xlsxToText, csvToText });

if (require.main === module) http.createServer(app).listen(PORT, '127.0.0.1', () => {
  console.log('Power BI cheat sheet at http://localhost:' + PORT);
  console.log(hasKey() ? 'Claude API key: found' : 'Claude API key: NOT set (edit .env to use the Messages section)');
});
