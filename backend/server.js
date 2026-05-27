const express = require('express');
const cors = require('cors');
const { createClient } = require('webdav');
const SMB2 = require('@marsaud/smb2');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_FILE = '/data/config.json';

// ── Global unhandled-rejection / uncaughtException guards ─────────────────────
// @marsaud/smb2 can throw unhandled 'error' events that crash the process.
// Catch everything here so nginx never sees a dead backend.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) {}
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { webdav: { url: 'https://webdav.torbox.app', username: '', password: '' }, smbShares: [], syncJobs: [], logs: [] };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function addLog(message, level = 'info') {
  const entry = { timestamp: new Date().toISOString(), level, message };
  console.log(`[${level}] ${message}`);
  const cfg = loadConfig();
  cfg.logs = cfg.logs || [];
  cfg.logs.unshift(entry);
  cfg.logs = cfg.logs.slice(0, 500);
  saveConfig(cfg);
  broadcast({ type: 'log', data: entry });
  return entry;
}

// ── SMB helper: create a client with error guard ──────────────────────────────
function createSmbClient(shareInfo) {
  const { host, share, username, password, domain } = shareInfo;
  const client = new SMB2({
    share: `\\\\${host}\\${share}`,
    domain: domain || 'WORKGROUP',
    username: username || '',
    password: password || '',
    autoCloseTimeout: 10000,
    packetConcurrency: 4,
  });
  // Absorb any error events the lib may emit outside of callbacks
  client.on('error', (err) => {
    console.error('[smb2 client error]', err.message);
  });
  return client;
}

function closeSmbClient(client) {
  if (!client) return;
  try { client.close(); } catch (_) {}
}

// Wrap smb2 callback into a promise with a timeout
function smbOp(fn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMB operation timed out')), timeoutMs);
    fn((err, result) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// ── SMB: build smbclient args correctly ───────────────────────────────────────
// Correct smbclient format:
//   smbclient //host/share -U "username%password" -W DOMAIN -c "command"
// The -U flag is "user%pass" ONLY — domain goes in -W, never prepended to -U.
// The old broken form "WORKGROUP\user%pass" caused the 502 errors.
function buildSmbArgs(host, share, username, password, domain, command) {
  const shareStr  = `//${host}/${share}`;
  // password can be empty — still need the % separator so smbclient doesn't prompt
  const userStr   = `${username}%${password || ''}`;
  const domainStr = domain || 'WORKGROUP';
  return [
    shareStr,
    '-U', userStr,
    '-W', domainStr,
    '--option=client min protocol=NT1',  // broader NAS compat (Synology, QNAP, TrueNAS, older Samba)
    '-c', command,
  ];
}

// Extract the most useful error line from smbclient stderr
function parseSmbError(stderr, fallback) {
  if (!stderr) return fallback;
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  const hit = lines.find(l =>
    l.includes('NT_STATUS') ||
    l.includes('Connection refused') ||
    l.includes('No route') ||
    l.includes('timed out') ||
    l.includes('LOGON_FAILURE') ||
    l.includes('Bad password') ||
    l.includes('Access denied') ||
    l.includes('Cannot connect')
  );
  return hit || lines[lines.length - 1] || fallback;
}

// ── SMB: test connection via smbclient CLI ────────────────────────────────────
function testSmbViaCli(host, share, username, password, domain) {
  return new Promise((resolve) => {
    const args = buildSmbArgs(host, share, username, password, domain, 'ls');
    // Log with password redacted
    const display = args.map((a, i) => (i > 0 && args[i-1] === '-U') ? a.replace(/%.*/, '%***') : a);
    console.log('[smbclient test] smbclient', display.join(' '));
    execFile('smbclient', args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = parseSmbError(stderr, err.message);
        console.error('[smbclient test error]', msg);
        resolve({ success: false, message: msg });
      } else {
        resolve({ success: true, message: 'Connected successfully' });
      }
    });
  });
}

// ── SMB: browse via smbclient CLI ─────────────────────────────────────────────
function browseSmbViaCli(host, share, username, password, domain, dirPath) {
  return new Promise((resolve) => {
    // Normalise path: strip leading slash, convert / to \ for smbclient cd command
    const normalised = (dirPath || '/').replace(/^\//, '').replace(/\//g, '\\');
    const cmd = normalised ? `cd "${normalised}"; ls` : 'ls';
    const args = buildSmbArgs(host, share, username, password, domain, cmd);
    execFile('smbclient', args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = parseSmbError(stderr, err.message);
        console.error('[smbclient browse error]', msg);
        resolve({ success: false, message: msg, contents: [] });
        return;
      }
      // Parse smbclient ls output lines, e.g.:
      //   "  My Folder              D        0  Mon Jan  1 00:00:00 2024"
      //   "  movie.mkv              A  1234567  Tue Feb  2 12:34:56 2024"
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

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tell nginx not to buffer
  res.flushHeaders();
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
});

// Config
app.get('/api/config', (req, res) => res.json(loadConfig()));

// ── WebDAV ────────────────────────────────────────────────────────────────────
app.post('/api/webdav', (req, res) => {
  const cfg = loadConfig();
  cfg.webdav = req.body;
  saveConfig(cfg);
  res.json({ success: true });
});

app.post('/api/webdav/test', async (req, res) => {
  try {
    const { url, username, password } = req.body;
    const client = createClient(url, { username, password });
    await client.getDirectoryContents('/');
    res.json({ success: true, message: 'Connected successfully' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/webdav/browse', async (req, res) => {
  try {
    const cfg = loadConfig();
    const { url, username, password } = cfg.webdav;
    const dirPath = req.query.path || '/';
    const client = createClient(url, { username, password });
    const contents = await client.getDirectoryContents(dirPath);
    res.json({
      success: true,
      contents: contents.map(f => ({
        name: f.basename,
        path: f.filename,
        type: f.type,
        size: f.size,
        lastmod: f.lastmod,
        mime: f.mime || null,
      }))
    });
  } catch (e) {
    res.json({ success: false, message: e.message, contents: [] });
  }
});

// ── SMB shares ────────────────────────────────────────────────────────────────
app.get('/api/smb', (req, res) => {
  const cfg = loadConfig();
  res.json(cfg.smbShares || []);
});

app.post('/api/smb', (req, res) => {
  const cfg = loadConfig();
  cfg.smbShares = cfg.smbShares || [];
  const share = { ...req.body, id: Date.now().toString(), lastStatus: 'unknown' };
  cfg.smbShares.push(share);
  saveConfig(cfg);
  res.json({ success: true, share });
});

app.put('/api/smb/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.smbShares.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  cfg.smbShares[idx] = { ...cfg.smbShares[idx], ...req.body, id: req.params.id };
  saveConfig(cfg);
  res.json({ success: true });
});

app.delete('/api/smb/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.smbShares = cfg.smbShares.filter(s => s.id !== req.params.id);
  saveConfig(cfg);
  res.json({ success: true });
});

// Test SMB — uses smbclient CLI, much more reliable than the Node lib for testing
app.post('/api/smb/test', async (req, res) => {
  const { host, share, username, password, domain, id } = req.body;
  try {
    const result = await testSmbViaCli(host, share, username, password, domain);
    // Persist the status
    if (id) {
      const cfg = loadConfig();
      const idx = cfg.smbShares.findIndex(s => s.id === id);
      if (idx !== -1) {
        cfg.smbShares[idx].lastStatus = result.success ? 'ok' : 'error';
        cfg.smbShares[idx].lastStatusMsg = result.message;
        cfg.smbShares[idx].lastTestedAt = new Date().toISOString();
        saveConfig(cfg);
      }
    }
    res.json(result);
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Browse SMB directory
app.get('/api/smb/:id/browse', async (req, res) => {
  const cfg = loadConfig();
  const share = cfg.smbShares.find(s => s.id === req.params.id);
  if (!share) return res.json({ success: false, message: 'Share not found', contents: [] });
  const dirPath = req.query.path || '/';
  try {
    const result = await browseSmbViaCli(share.host, share.share, share.username, share.password, share.domain, dirPath);
    res.json(result);
  } catch (e) {
    res.json({ success: false, message: e.message, contents: [] });
  }
});

// ── Sync jobs ─────────────────────────────────────────────────────────────────
app.post('/api/jobs', (req, res) => {
  const cfg = loadConfig();
  cfg.syncJobs = cfg.syncJobs || [];
  const job = { ...req.body, id: Date.now().toString(), status: 'idle', lastRun: null, filesCopied: 0 };
  cfg.syncJobs.push(job);
  saveConfig(cfg);
  res.json({ success: true, job });
});

app.put('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.syncJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  cfg.syncJobs[idx] = { ...cfg.syncJobs[idx], ...req.body, id: req.params.id };
  saveConfig(cfg);
  res.json({ success: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.syncJobs = cfg.syncJobs.filter(j => j.id !== req.params.id);
  saveConfig(cfg);
  res.json({ success: true });
});

app.post('/api/jobs/:id/run', async (req, res) => {
  const cfg = loadConfig();
  const job = cfg.syncJobs.find(j => j.id === req.params.id);
  if (!job) return res.json({ success: false, message: 'Job not found' });
  if (job.status === 'running') return res.json({ success: false, message: 'Already running' });
  res.json({ success: true, message: 'Sync started' });
  runSyncJob(job.id).catch(e => console.error('[runSyncJob unhandled]', e.message));
});

async function runSyncJob(jobId) {
  const cfg = loadConfig();
  const jobIdx = cfg.syncJobs.findIndex(j => j.id === jobId);
  if (jobIdx === -1) return;

  const job = cfg.syncJobs[jobIdx];
  const smbShareCfg = cfg.smbShares.find(s => s.id === job.smbShareId);
  if (!smbShareCfg) { addLog(`Job "${job.name}": SMB share not found`, 'error'); return; }

  cfg.syncJobs[jobIdx].status = 'running';
  saveConfig(cfg);
  broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'running' } });
  addLog(`Starting sync job "${job.name}"`, 'info');

  let smb2 = null;
  let filesCopied = 0;
  let errors = 0;

  try {
    const { url, username: wUser, password: wPass } = cfg.webdav;
    const webdavClient = createClient(url, { username: wUser, password: wPass });

    smb2 = createSmbClient(smbShareCfg);
    const smbWriteFile = promisify(smb2.writeFile.bind(smb2));
    const smbMkdir = promisify(smb2.mkdir.bind(smb2));
    const smbExists = (p) => smbOp(cb => smb2.exists(p, cb), 8000).then(r => !!r).catch(() => false);

    const allowedExts = (job.fileTypes || []).map(e => e.toLowerCase().replace(/^\./, ''));

    async function syncDir(davPath, smbPath) {
      const contents = await webdavClient.getDirectoryContents(davPath);
      for (const item of contents) {
        const itemSmbPath = smbPath ? `${smbPath}\\${item.basename}` : item.basename;
        if (item.type === 'directory' && job.recursive) {
          try {
            const exists = await smbExists(itemSmbPath);
            if (!exists) await smbMkdir(itemSmbPath).catch(() => {});
          } catch (_) {}
          await syncDir(item.filename, itemSmbPath);
        } else if (item.type === 'file') {
          const ext = item.basename.split('.').pop()?.toLowerCase() || '';
          if (allowedExts.length > 0 && !allowedExts.includes(ext)) continue;
          try {
            const exists = await smbExists(itemSmbPath);
            if (exists && !job.overwrite) { addLog(`Skipping (exists): ${item.filename}`, 'debug'); continue; }
            addLog(`Copying: ${item.filename} → \\\\${smbShareCfg.host}\\${smbShareCfg.share}\\${itemSmbPath}`, 'info');
            broadcast({ type: 'progress', data: { jobId, file: item.filename } });
            const buf = await webdavClient.getFileContents(item.filename);
            await smbWriteFile(itemSmbPath, buf);
            filesCopied++;
            broadcast({ type: 'filesCopied', data: { jobId, count: filesCopied } });
          } catch (e) {
            errors++;
            addLog(`Error copying ${item.filename}: ${e.message}`, 'error');
          }
        }
      }
    }

    await syncDir(job.webdavPath || '/', job.smbDestPath || '');
    addLog(`Job "${job.name}" completed: ${filesCopied} files copied, ${errors} errors`, errors > 0 ? 'warn' : 'info');

    const cfg2 = loadConfig();
    const idx2 = cfg2.syncJobs.findIndex(j => j.id === jobId);
    if (idx2 !== -1) {
      cfg2.syncJobs[idx2].status = 'idle';
      cfg2.syncJobs[idx2].lastRun = new Date().toISOString();
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
    closeSmbClient(smb2);
  }
}

// Logs
app.get('/api/logs', (req, res) => { res.json(loadConfig().logs || []); });
app.delete('/api/logs', (req, res) => { const cfg = loadConfig(); cfg.logs = []; saveConfig(cfg); res.json({ success: true }); });

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  addLog('Server started', 'info');
});
