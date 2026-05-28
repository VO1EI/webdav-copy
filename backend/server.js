const express    = require('express');
const cors       = require('cors');
const { createClient } = require('webdav');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { execFile } = require('child_process');
const cron       = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_FILE = '/data/config.json';

// ── Crash guards ──────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[uncaughtException]',  e.message));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (_) {} }
}

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { webdav: { url: 'https://webdav.torbox.app', username: '', password: '' }, smbShares: [], syncJobs: [], logs: [] };
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function addLog(message, level = 'info') {
  const entry = { timestamp: new Date().toISOString(), level, message };
  console.log(`[${level}] ${message}`);
  const cfg = loadConfig();
  cfg.logs = (cfg.logs || []);
  cfg.logs.unshift(entry);
  cfg.logs = cfg.logs.slice(0, 500);
  saveConfig(cfg);
  broadcast({ type: 'log', data: entry });
  return entry;
}

// ── Job stop signals ──────────────────────────────────────────────────────────
// Map of jobId → true when a stop has been requested
const stopRequested = new Map();

// ── smbclient helpers ─────────────────────────────────────────────────────────
function buildSmbArgs(host, share, username, password, domain, command) {
  const cleanHost   = (host   || '').trim();
  const cleanShare  = (share  || '').trim();
  const cleanUser   = (username || '').trim();
  const cleanPass   = (password || '').toString().trim();
  const cleanDomain = (domain || 'WORKGROUP').trim();
  if (!cleanHost)  throw new Error('Host is required');
  if (!cleanShare) throw new Error('Share name is required');
  return [
    `//${cleanHost}/${cleanShare}`,
    '-U', `${cleanUser}%${cleanPass}`,
    '-W', cleanDomain,
    '--option', 'client min protocol=NT1',
    '-t', '10',
    '-c', command,
  ];
}

function parseSmbError(stderr, fallback) {
  if (!stderr) return fallback;
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l =>
    l.includes('NT_STATUS') || l.includes('Connection refused') ||
    l.includes('No route') || l.includes('timed out') ||
    l.includes('LOGON_FAILURE') || l.includes('Bad password') ||
    l.includes('Access denied') || l.includes('Cannot connect')
  ) || lines[lines.length - 1] || fallback;
}

function testSmbViaCli(host, share, username, password, domain) {
  return new Promise(resolve => {
    const args = buildSmbArgs(host, share, username, password, domain, 'ls');
    const display = args.map((a,i) => (i>0 && args[i-1]==='-U') ? a.replace(/%.*/, '%***') : a);
    console.log('[smbclient test]', display.join(' '));
    execFile('smbclient', args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) { resolve({ success: false, message: parseSmbError(stderr, err.message) }); }
      else      { resolve({ success: true,  message: 'Connected successfully' }); }
    });
  });
}

function browseSmbViaCli(host, share, username, password, domain, dirPath) {
  return new Promise(resolve => {
    const normalised = (dirPath || '/').replace(/^\//, '').replace(/\//g, '\\');
    const cmd  = normalised ? `cd "${normalised}"; ls` : 'ls';
    const args = buildSmbArgs(host, share, username, password, domain, cmd);
    execFile('smbclient', args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) { resolve({ success: false, message: parseSmbError(stderr, err.message), contents: [] }); return; }
      const items = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s{2}(.+?)\s{2,}([DAHRNS]+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const name = m[1].trimEnd();
        if (name === '.' || name === '..') continue;
        const isDir   = m[2].includes('D');
        const size    = parseInt(m[3], 10);
        const subPath = dirPath && dirPath !== '/'
          ? `${dirPath}/${name}`.replace(/\/+/g, '/')
          : `/${name}`;
        items.push({ name, path: subPath, type: isDir ? 'directory' : 'file', size, lastmod: m[4].trim() });
      }
      resolve({ success: true, contents: items });
    });
  });
}

// Write a Buffer to an SMB share via smbclient put
function writeSmbFileCli(shareInfo, smbDestPath, buffer) {
  return new Promise((resolve, reject) => {
    const { host, share, username, password, domain } = shareInfo;
    const tmpFile = path.join(os.tmpdir(), `zs_upload_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmpFile, buffer);
    const winPath = smbDestPath.replace(/\//g, '\\').replace(/^\\+/, '');
    const cmd  = `put "${tmpFile}" "${winPath}"`;
    const args = buildSmbArgs(host, share, username, password, domain, cmd);
    execFile('smbclient', args, { timeout: 300000, maxBuffer: 1024*1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (err) reject(new Error(parseSmbError(stderr, err.message)));
      else     resolve();
    });
  });
}

// Read a file from an SMB share via smbclient get
function readSmbFileCli(shareInfo, smbSrcPath) {
  return new Promise((resolve, reject) => {
    const { host, share, username, password, domain } = shareInfo;
    const tmpFile = path.join(os.tmpdir(), `zs_download_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const winPath = smbSrcPath.replace(/\//g, '\\').replace(/^\\+/, '');
    const cmd  = `get "${winPath}" "${tmpFile}"`;
    const args = buildSmbArgs(host, share, username, password, domain, cmd);
    execFile('smbclient', args, { timeout: 300000, maxBuffer: 1024*1024 }, (err, stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        reject(new Error(parseSmbError(stderr, err.message)));
      } else {
        try {
          const buf = fs.readFileSync(tmpFile);
          fs.unlinkSync(tmpFile);
          resolve(buf);
        } catch (e) { reject(e); }
      }
    });
  });
}

function makeSmbDirCli(shareInfo, smbDirPath) {
  return new Promise(resolve => {
    const { host, share, username, password, domain } = shareInfo;
    const winPath = smbDirPath.replace(/\//g, '\\').replace(/^\\+/, '');
    const args = buildSmbArgs(host, share, username, password, domain, `mkdir "${winPath}"`);
    execFile('smbclient', args, { timeout: 15000 }, () => resolve());
  });
}

function smbExistsCli(shareInfo, smbPath) {
  return new Promise(resolve => {
    const { host, share, username, password, domain } = shareInfo;
    const winPath = smbPath.replace(/\//g, '\\').replace(/^\\+/, '');
    const parts   = winPath.split('\\');
    const name    = parts.pop();
    const parent  = parts.join('\\');
    const cmd     = parent ? `cd "${parent}"; ls "${name}"` : `ls "${name}"`;
    const args    = buildSmbArgs(host, share, username, password, domain, cmd);
    execFile('smbclient', args, { timeout: 10000 }, (err, stdout) => {
      resolve(!err && stdout.includes(name));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); sseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
});

app.get('/api/config',  (req, res) => res.json(loadConfig()));
app.get('/api/health',  (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── WebDAV ────────────────────────────────────────────────────────────────────
app.post('/api/webdav', (req, res) => {
  const cfg = loadConfig(); cfg.webdav = req.body; saveConfig(cfg); res.json({ success: true });
});
app.post('/api/webdav/test', async (req, res) => {
  try {
    const { url, username, password } = req.body;
    await createClient(url, { username, password }).getDirectoryContents('/');
    res.json({ success: true, message: 'Connected successfully' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});
app.get('/api/webdav/browse', async (req, res) => {
  try {
    const { url, username, password } = loadConfig().webdav;
    const contents = await createClient(url, { username, password }).getDirectoryContents(req.query.path || '/');
    res.json({ success: true, contents: contents.map(f => ({ name: f.basename, path: f.filename, type: f.type, size: f.size, lastmod: f.lastmod })) });
  } catch (e) { res.json({ success: false, message: e.message, contents: [] }); }
});

// ── SMB Shares ────────────────────────────────────────────────────────────────
app.get('/api/smb', (req, res) => res.json(loadConfig().smbShares || []));

app.post('/api/smb', (req, res) => {
  const cfg = loadConfig();
  const share = { ...req.body, id: Date.now().toString(), lastStatus: 'unknown' };
  (cfg.smbShares = cfg.smbShares || []).push(share);
  saveConfig(cfg); res.json({ success: true, share });
});
app.put('/api/smb/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.smbShares.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  cfg.smbShares[idx] = { ...cfg.smbShares[idx], ...req.body, id: req.params.id };
  saveConfig(cfg); res.json({ success: true });
});
app.delete('/api/smb/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.smbShares = cfg.smbShares.filter(s => s.id !== req.params.id);
  saveConfig(cfg); res.json({ success: true });
});
app.post('/api/smb/test', async (req, res) => {
  const { host, share, username, password, domain, id } = req.body;
  console.log('[smb/test]', { host, share, username, domain, id });
  if (!host || !share) return res.json({ success: false, message: `Missing: ${!host ? 'host' : 'share name'}` });
  try {
    const result = await testSmbViaCli(host, share, username, password, domain);
    if (id) {
      const cfg = loadConfig();
      const idx = cfg.smbShares.findIndex(s => s.id === id);
      if (idx !== -1) {
        cfg.smbShares[idx].lastStatus    = result.success ? 'ok' : 'error';
        cfg.smbShares[idx].lastStatusMsg = result.message;
        cfg.smbShares[idx].lastTestedAt  = new Date().toISOString();
        saveConfig(cfg);
      }
    }
    res.json(result);
  } catch (e) { res.json({ success: false, message: e.message }); }
});
app.get('/api/smb/:id/browse', async (req, res) => {
  const share = loadConfig().smbShares.find(s => s.id === req.params.id);
  if (!share) return res.json({ success: false, message: 'Share not found', contents: [] });
  try {
    res.json(await browseSmbViaCli(share.host, share.share, share.username, share.password, share.domain, req.query.path || '/'));
  } catch (e) { res.json({ success: false, message: e.message, contents: [] }); }
});

// ── Sync Jobs ─────────────────────────────────────────────────────────────────
app.post('/api/jobs', (req, res) => {
  const cfg = loadConfig();
  const job = { ...req.body, id: Date.now().toString(), status: 'idle', lastRun: null, filesCopied: 0 };
  (cfg.syncJobs = cfg.syncJobs || []).push(job);
  saveConfig(cfg); registerJobSchedule(job); res.json({ success: true, job });
});
app.put('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.syncJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  cfg.syncJobs[idx] = { ...cfg.syncJobs[idx], ...req.body, id: req.params.id };
  saveConfig(cfg); registerJobSchedule(cfg.syncJobs[idx]); res.json({ success: true });
});
app.delete('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  unregisterJobSchedule(req.params.id);
  cfg.syncJobs = cfg.syncJobs.filter(j => j.id !== req.params.id);
  saveConfig(cfg); res.json({ success: true });
});
app.post('/api/jobs/:id/run', async (req, res) => {
  const cfg = loadConfig();
  const job = cfg.syncJobs.find(j => j.id === req.params.id);
  if (!job) return res.json({ success: false, message: 'Job not found' });
  if (job.status === 'running') return res.json({ success: false, message: 'Already running' });
  res.json({ success: true, message: 'Sync started' });
  runSyncJob(job.id).catch(e => console.error('[runSyncJob]', e.message));
});
app.post('/api/jobs/:id/stop', (req, res) => {
  const cfg = loadConfig();
  const job = cfg.syncJobs.find(j => j.id === req.params.id);
  if (!job) return res.json({ success: false, message: 'Job not found' });
  if (job.status !== 'running') return res.json({ success: false, message: 'Job is not running' });
  stopRequested.set(req.params.id, true);
  addLog(`Stop requested for job "${job.name}"`, 'warn');
  res.json({ success: true, message: 'Stop signal sent' });
});
app.patch('/api/jobs/:id/schedule', (req, res) => {
  const { schedule } = req.body;
  const cfg = loadConfig();
  const idx = cfg.syncJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  if (schedule && schedule !== 'manual' && !INTERVAL_PRESETS[schedule] && !cron.validate(schedule))
    return res.json({ success: false, message: `Invalid cron expression: "${schedule}"` });
  cfg.syncJobs[idx].schedule = schedule || 'manual';
  saveConfig(cfg); registerJobSchedule(cfg.syncJobs[idx]);
  broadcast({ type: 'jobUpdate', data: { id: req.params.id, schedule: cfg.syncJobs[idx].schedule } });
  res.json({ success: true });
});
app.post('/api/cron/validate', (req, res) => {
  const { expr } = req.body;
  if (!expr) return res.json({ valid: false });
  res.json({ valid: cron.validate(expr) });
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs',    (req, res) => res.json(loadConfig().logs || []));
app.delete('/api/logs', (req, res) => { const cfg = loadConfig(); cfg.logs = []; saveConfig(cfg); res.json({ success: true }); });

// ─────────────────────────────────────────────────────────────────────────────
// SYNC ENGINE
// ─────────────────────────────────────────────────────────────────────────────
async function runSyncJob(jobId) {
  const cfg    = loadConfig();
  const jobIdx = cfg.syncJobs.findIndex(j => j.id === jobId);
  if (jobIdx === -1) return;

  const job = cfg.syncJobs[jobIdx];
  stopRequested.delete(jobId); // clear any stale stop signal

  // ── Resolve source & destination ──────────────────────────────────────────
  // sourceType: 'webdav' | 'smb'
  const sourceType = job.sourceType || 'webdav';
  const destShare  = cfg.smbShares.find(s => s.id === job.smbShareId);
  if (!destShare) { addLog(`Job "${job.name}": destination SMB share not found`, 'error'); return; }

  let srcShare = null;
  if (sourceType === 'smb') {
    srcShare = cfg.smbShares.find(s => s.id === job.srcSmbShareId);
    if (!srcShare) { addLog(`Job "${job.name}": source SMB share not found`, 'error'); return; }
  }

  cfg.syncJobs[jobIdx].status = 'running';
  saveConfig(cfg);
  broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'running' } });
  addLog(`Starting job "${job.name}" [${sourceType} → SMB]`, 'info');

  let filesCopied = 0;
  let errors      = 0;

  // Helper: check if stop was requested
  const shouldStop = () => stopRequested.get(jobId) === true;

  const allowedExts = (job.fileTypes || []).map(e => e.toLowerCase().replace(/^\./, ''));
  addLog(`Filter: ${allowedExts.length ? allowedExts.join(', ') : 'all files'}`, 'info');

  // ── Destination SMB helpers ───────────────────────────────────────────────
  const smbWrite  = (p, buf) => writeSmbFileCli(destShare, p, buf);
  const smbMkdir  = (p)     => makeSmbDirCli(destShare, p);
  const smbExists = (p)     => smbExistsCli(destShare, p);
  const smbJoin   = (...parts) => parts.filter(p => p && p !== '\\' && p !== '/').join('\\');

  const madeSmb = new Set();
  async function ensureSmbDir(p) {
    if (!p || madeSmb.has(p)) return;
    const segs = p.split('\\').filter(Boolean);
    let built = '';
    for (const seg of segs) {
      built = built ? `${built}\\${seg}` : seg;
      if (madeSmb.has(built)) continue;
      try {
        if (!await smbExists(built)) { addLog(`mkdir: ${built}`, 'debug'); await smbMkdir(built); }
      } catch (e) {
        if (!e.message?.includes('NAME_COLLISION') && !e.message?.includes('exist'))
          addLog(`Warning mkdir ${built}: ${e.message}`, 'warn');
      }
      madeSmb.add(built);
    }
  }

  try {
    // ── Test destination SMB connection ─────────────────────────────────────
    addLog(`Connecting to destination: \\\\${destShare.host}\\${destShare.share}`, 'info');
    const destTest = await testSmbViaCli(destShare.host, destShare.share, destShare.username, destShare.password, destShare.domain);
    if (!destTest.success) throw new Error(`Destination SMB failed: ${destTest.message}`);
    addLog('Destination SMB OK', 'info');

    // ── SOURCE: WebDAV ──────────────────────────────────────────────────────
    if (sourceType === 'webdav') {
      const { url, username: wUser, password: wPass } = cfg.webdav;
      const davClient = createClient(url, { username: wUser, password: wPass });

      async function treeHasMatch(davPath) {
        let items; try { items = await davClient.getDirectoryContents(davPath); } catch (_) { return false; }
        for (const item of items) {
          if (item.type === 'file') {
            if (!allowedExts.length) return true;
            if (allowedExts.includes((item.basename.split('.').pop()||'').toLowerCase())) return true;
          } else if (item.type === 'directory' && await treeHasMatch(item.filename)) return true;
        }
        return false;
      }

      async function syncWebdavDir(davPath, smbPath) {
        if (shouldStop()) return;
        addLog(`Scanning WebDAV: ${davPath}`, 'debug');
        let contents;
        try { contents = await davClient.getDirectoryContents(davPath); }
        catch (e) { addLog(`Cannot list ${davPath}: ${e.message}`, 'error'); errors++; return; }

        for (const item of contents) {
          if (shouldStop()) { addLog('Job stopped by user', 'warn'); return; }
          const dest = smbJoin(smbPath, item.basename);

          if (item.type === 'directory') {
            if (!job.recursive) continue;
            const hasMatch = !allowedExts.length || await treeHasMatch(item.filename);
            if (!hasMatch) { addLog(`Skip folder (no matches): ${item.filename}`, 'debug'); continue; }
            await ensureSmbDir(dest);
            await syncWebdavDir(item.filename, dest);

          } else if (item.type === 'file') {
            const ext = (item.basename.split('.').pop()||'').toLowerCase();
            if (allowedExts.length && !allowedExts.includes(ext)) continue;
            if (smbPath) await ensureSmbDir(smbPath);
            try {
              if (!job.overwrite && await smbExists(dest)) { addLog(`Skip (exists): ${item.basename}`, 'debug'); continue; }
              addLog(`Copying [${formatBytes(item.size)}]: ${item.filename}`, 'info');
              broadcast({ type: 'progress', data: { jobId, file: item.filename } });
              const raw = await davClient.getFileContents(item.filename, { format: 'binary' });
              const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              await smbWrite(dest, buf);
              addLog(`OK: ${item.basename}`, 'info');
              filesCopied++;
              broadcast({ type: 'filesCopied', data: { jobId, count: filesCopied } });
            } catch (e) { errors++; addLog(`Error: ${item.filename}: ${e.message}`, 'error'); }
          }
        }
      }

      const startDest = (job.smbDestPath || '').replace(/\//g, '\\').replace(/^\\+/, '');
      addLog(`Sync: WebDAV ${job.webdavPath||'/'} → \\\\${destShare.host}\\${destShare.share}\\${startDest||'(root)'}`, 'info');
      await syncWebdavDir(job.webdavPath || '/', startDest);

    // ── SOURCE: SMB ─────────────────────────────────────────────────────────
    } else if (sourceType === 'smb') {
      addLog(`Connecting to source: \\\\${srcShare.host}\\${srcShare.share}`, 'info');
      const srcTest = await testSmbViaCli(srcShare.host, srcShare.share, srcShare.username, srcShare.password, srcShare.domain);
      if (!srcTest.success) throw new Error(`Source SMB failed: ${srcTest.message}`);
      addLog('Source SMB OK', 'info');

      async function treeHasMatchSmb(srcInfo, smbPath) {
        const result = await browseSmbViaCli(srcInfo.host, srcInfo.share, srcInfo.username, srcInfo.password, srcInfo.domain, smbPath);
        if (!result.success) return false;
        for (const item of result.contents) {
          if (item.type === 'file') {
            if (!allowedExts.length) return true;
            if (allowedExts.includes((item.name.split('.').pop()||'').toLowerCase())) return true;
          } else if (item.type === 'directory' && await treeHasMatchSmb(srcInfo, item.path)) return true;
        }
        return false;
      }

      async function syncSmbDir(srcSmbPath, destSmbPath) {
        if (shouldStop()) return;
        addLog(`Scanning SMB source: ${srcSmbPath || '/'}`, 'debug');
        const result = await browseSmbViaCli(srcShare.host, srcShare.share, srcShare.username, srcShare.password, srcShare.domain, srcSmbPath || '/');
        if (!result.success) { addLog(`Cannot list source ${srcSmbPath}: ${result.message}`, 'error'); errors++; return; }

        for (const item of result.contents) {
          if (shouldStop()) { addLog('Job stopped by user', 'warn'); return; }
          const dest = smbJoin(destSmbPath, item.name);

          if (item.type === 'directory') {
            if (!job.recursive) continue;
            const hasMatch = !allowedExts.length || await treeHasMatchSmb(srcShare, item.path);
            if (!hasMatch) { addLog(`Skip folder (no matches): ${item.path}`, 'debug'); continue; }
            await ensureSmbDir(dest);
            await syncSmbDir(item.path, dest);

          } else if (item.type === 'file') {
            const ext = (item.name.split('.').pop()||'').toLowerCase();
            if (allowedExts.length && !allowedExts.includes(ext)) continue;
            if (destSmbPath) await ensureSmbDir(destSmbPath);
            try {
              if (!job.overwrite && await smbExists(dest)) { addLog(`Skip (exists): ${item.name}`, 'debug'); continue; }
              addLog(`Copying [${formatBytes(item.size)}]: ${item.path}`, 'info');
              broadcast({ type: 'progress', data: { jobId, file: item.path } });
              const buf = await readSmbFileCli(srcShare, item.path);
              await smbWrite(dest, buf);
              addLog(`OK: ${item.name}`, 'info');
              filesCopied++;
              broadcast({ type: 'filesCopied', data: { jobId, count: filesCopied } });
            } catch (e) { errors++; addLog(`Error: ${item.path}: ${e.message}`, 'error'); }
          }
        }
      }

      const startSrc  = (job.srcSmbPath  || '').replace(/\\/g, '/');
      const startDest = (job.smbDestPath || '').replace(/\//g, '\\').replace(/^\\+/, '');
      addLog(`Sync: \\\\${srcShare.host}\\${srcShare.share}\\${startSrc||'(root)'} → \\\\${destShare.host}\\${destShare.share}\\${startDest||'(root)'}`, 'info');
      await syncSmbDir(startSrc || '/', startDest);
    }

    const stopped = shouldStop();
    addLog(
      `Job "${job.name}" ${stopped ? 'stopped' : 'completed'}: ${filesCopied} files copied, ${errors} errors`,
      stopped ? 'warn' : errors > 0 ? 'warn' : 'info'
    );

    const cfg2 = loadConfig();
    const idx2 = cfg2.syncJobs.findIndex(j => j.id === jobId);
    if (idx2 !== -1) {
      cfg2.syncJobs[idx2].status     = stopped ? 'idle' : 'idle';
      cfg2.syncJobs[idx2].lastRun    = new Date().toISOString();
      cfg2.syncJobs[idx2].filesCopied = (cfg2.syncJobs[idx2].filesCopied || 0) + filesCopied;
      saveConfig(cfg2);
    }
    broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'idle', lastRun: new Date().toISOString() } });

  } catch (e) {
    addLog(`Job "${job.name}" failed: ${e.message}`, 'error');
    const cfg2 = loadConfig();
    const idx2 = cfg2.syncJobs.findIndex(j => j.id === jobId);
    if (idx2 !== -1) { cfg2.syncJobs[idx2].status = 'error'; cfg2.syncJobs[idx2].lastRun = new Date().toISOString(); saveConfig(cfg2); }
    broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'error' } });
  } finally {
    stopRequested.delete(jobId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────
const INTERVAL_PRESETS = {
  '15min':  '*/15 * * * *', '30min':  '*/30 * * * *',
  '1hour':  '0 * * * *',    '3hour':  '0 */3 * * *',
  '6hour':  '0 */6 * * *',  '12hour': '0 */12 * * *',
  '24hour': '0 0 * * *',    'manual': null,
};
function cronExprForJob(job) {
  if (!job.schedule || job.schedule === 'manual') return null;
  return INTERVAL_PRESETS[job.schedule] !== undefined ? INTERVAL_PRESETS[job.schedule] : job.schedule;
}

const scheduledTasks = new Map();
function registerJobSchedule(job) {
  if (scheduledTasks.has(job.id)) { try { scheduledTasks.get(job.id).stop(); } catch (_) {} scheduledTasks.delete(job.id); }
  const expr = cronExprForJob(job);
  if (!expr || !cron.validate(expr)) return;
  const task = cron.schedule(expr, () => {
    const cfg = loadConfig();
    const current = cfg.syncJobs.find(j => j.id === job.id);
    if (!current || current.status === 'running') return;
    addLog(`Scheduled run: "${current.name}"`, 'info');
    runSyncJob(job.id).catch(e => console.error('[scheduler]', e.message));
  }, { scheduled: true, timezone: process.env.TZ || 'UTC' });
  scheduledTasks.set(job.id, task);
  console.log(`[scheduler] "${job.name}" → ${expr}`);
}
function unregisterJobSchedule(id) {
  if (scheduledTasks.has(id)) { try { scheduledTasks.get(id).stop(); } catch (_) {} scheduledTasks.delete(id); }
}
function initScheduler() {
  const cfg = loadConfig();
  let count = 0;
  for (const job of cfg.syncJobs || []) {
    if (job.status === 'running') job.status = 'idle';
    registerJobSchedule(job);
    if (cronExprForJob(job)) count++;
  }
  saveConfig(cfg);
  addLog(`Scheduler: ${count} job(s) scheduled`, 'info');
  (cfg.syncJobs || []).filter(j => cronExprForJob(j)).forEach((job, i) => {
    setTimeout(() => runSyncJob(job.id).catch(e => console.error('[startup]', e.message)), 2000 + i * 1500);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Zerosync backend on port ${PORT}`);
  addLog('Server started', 'info');
  setTimeout(initScheduler, 1000);
});
