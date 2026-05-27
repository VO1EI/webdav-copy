const express = require('express');
const cors = require('cors');
const { createClient } = require('webdav');
const SMB2 = require('@marsaud/smb2');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const cron = require('node-cron');

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

function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(2) + ' GB';
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

// ── SMB helper: create a client ──────────────────────────────────────────────
// NOTE: @marsaud/smb2 does NOT extend EventEmitter — never call .on() on it.
// All error handling is via callback err arguments only.
function createSmbClient(shareInfo) {
  const { host, share, username, password, domain } = shareInfo;
  return new SMB2({
    share: `\\\\${host}\\${share}`,
    domain: domain || 'WORKGROUP',
    username: username || '',
    password: password || '',
    autoCloseTimeout: 10000,
    packetConcurrency: 4,
  });
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
  // Sanitise inputs — trim whitespace that might sneak in from the UI form
  const cleanHost   = (host   || '').trim();
  const cleanShare  = (share  || '').trim();
  const cleanUser   = (username || '').trim();
  const cleanPass   = (password || '').toString().trim();
  const cleanDomain = (domain || 'WORKGROUP').trim();

  if (!cleanHost)  throw new Error('Host is required');
  if (!cleanShare) throw new Error('Share name is required');

  const shareStr = `//${cleanHost}/${cleanShare}`;
  // "user%pass" — the % separator stops smbclient from prompting interactively
  const userStr  = `${cleanUser}%${cleanPass}`;

  console.log('[smbclient] share path:', shareStr, '| user:', cleanUser, '| domain:', cleanDomain);

  return [
    shareStr,
    '-U', userStr,
    '-W', cleanDomain,
    // NOTE: '--option=X Y' with a space MUST be two separate args when using execFile
    '--option', 'client min protocol=NT1',
    '-t', '10',          // socket timeout in seconds
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
  // Debug: log exactly what we received (password redacted)
  console.log('[smb/test] received:', { host, share, username, domain, id, password: password ? '***' : '(empty)' });
  if (!host || !share) {
    return res.json({ success: false, message: `Missing required field: ${!host ? 'host' : 'share name'}` });
  }
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
  registerJobSchedule(job);
  res.json({ success: true, job });
});

app.put('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.syncJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  cfg.syncJobs[idx] = { ...cfg.syncJobs[idx], ...req.body, id: req.params.id };
  saveConfig(cfg);
  registerJobSchedule(cfg.syncJobs[idx]);
  res.json({ success: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const cfg = loadConfig();
  unregisterJobSchedule(req.params.id);
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

    addLog(`Connecting to SMB: \\\\${smbShareCfg.host}\\${smbShareCfg.share}`, 'info');
    smb2 = createSmbClient(smbShareCfg);

    // Promisified SMB ops
    const smbWriteFile = promisify(smb2.writeFile.bind(smb2));
    const smbMkdir    = promisify(smb2.mkdir.bind(smb2));
    const smbReaddir  = promisify(smb2.readdir.bind(smb2));

    // exists() returns bool via callback — wrap safely
    const smbExists = (p) => new Promise(resolve => {
      smb2.exists(p, (err, exists) => resolve(!err && !!exists));
    });

    // Verify SMB connection works before starting
    try {
      await smbReaddir('');
      addLog('SMB connection verified OK', 'info');
    } catch (e) {
      throw new Error(`SMB connection failed: ${e.message}`);
    }

    // Allowed extensions (empty = all files)
    const allowedExts = (job.fileTypes || []).map(e => e.toLowerCase().replace(/^\./, ''));
    addLog(`File filter: ${allowedExts.length ? allowedExts.join(', ') : 'all files'}`, 'info');

    // smbPath uses backslash separator — join helper
    const smbJoin = (...parts) => parts.filter(p => p && p !== '\\' && p !== '/').join('\\');

    // Cache of SMB dirs we've already created/verified this run
    const madeSmb = new Set();

    // Create a directory and all its parents on the SMB share
    async function ensureSmbDir(smbPath) {
      if (!smbPath || madeSmb.has(smbPath)) return;
      // Build each path segment bottom-up
      const parts = smbPath.split('\\').filter(Boolean);
      let cumulative = '';
      for (const part of parts) {
        cumulative = cumulative ? `${cumulative}\\${part}` : part;
        if (madeSmb.has(cumulative)) continue;
        try {
          const exists = await smbExists(cumulative);
          if (!exists) {
            addLog(`mkdir: ${cumulative}`, 'debug');
            await smbMkdir(cumulative);
          }
        } catch (e) {
          // STATUS_OBJECT_NAME_COLLISION = already exists — safe to ignore
          if (!e.message?.includes('NAME_COLLISION') && !e.message?.includes('exist')) {
            addLog(`Warning mkdir ${cumulative}: ${e.message}`, 'warn');
          }
        }
        madeSmb.add(cumulative);
      }
    }

    // Does this WebDAV subtree contain any file matching our filter?
    async function treeHasMatch(davPath) {
      let items;
      try { items = await webdavClient.getDirectoryContents(davPath); }
      catch (_) { return false; }
      for (const item of items) {
        if (item.type === 'file') {
          if (!allowedExts.length) return true;
          const ext = (item.basename.split('.').pop() || '').toLowerCase();
          if (allowedExts.includes(ext)) return true;
        } else if (item.type === 'directory') {
          if (await treeHasMatch(item.filename)) return true;
        }
      }
      return false;
    }

    async function syncDir(davPath, smbPath) {
      addLog(`Scanning: ${davPath}${smbPath ? ' → ' + smbPath : ''}`, 'debug');

      let contents;
      try {
        contents = await webdavClient.getDirectoryContents(davPath);
      } catch (e) {
        addLog(`Cannot list ${davPath}: ${e.message}`, 'error');
        errors++;
        return;
      }

      addLog(`Found ${contents.length} items in ${davPath}`, 'debug');

      for (const item of contents) {
        const destPath = smbJoin(smbPath, item.basename);

        if (item.type === 'directory') {
          if (!job.recursive) continue;
          // Skip directories whose entire subtree has no matching files
          const hasMatch = !allowedExts.length || await treeHasMatch(item.filename);
          if (!hasMatch) {
            addLog(`Skipping folder (no matching files): ${item.filename}`, 'debug');
            continue;
          }
          await ensureSmbDir(destPath);
          await syncDir(item.filename, destPath);

        } else if (item.type === 'file') {
          const ext = (item.basename.split('.').pop() || '').toLowerCase();
          if (allowedExts.length && !allowedExts.includes(ext)) {
            addLog(`Filtered out: ${item.basename} (.${ext})`, 'debug');
            continue;
          }

          // Make sure the destination directory exists
          if (smbPath) await ensureSmbDir(smbPath);

          try {
            const exists = await smbExists(destPath);
            if (exists && !job.overwrite) {
              addLog(`Skip (exists): ${item.filename}`, 'debug');
              continue;
            }

            addLog(`Copying [${formatBytes(item.size)}]: ${item.filename}`, 'info');
            broadcast({ type: 'progress', data: { jobId, file: item.filename } });

            // Download from WebDAV as Buffer (not ArrayBuffer)
            const raw = await webdavClient.getFileContents(item.filename, { format: 'binary' });
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

            addLog(`Writing to SMB: ${destPath} (${buf.length} bytes)`, 'debug');
            await smbWriteFile(destPath, buf);
            addLog(`OK: ${item.basename}`, 'info');
            filesCopied++;
            broadcast({ type: 'filesCopied', data: { jobId, count: filesCopied } });
          } catch (e) {
            errors++;
            addLog(`Error copying ${item.filename}: ${e.message}`, 'error');
          }
        }
      }
    }

    const startSmbPath = (job.smbDestPath || '').replace(/\//g, '\\').replace(/^\\+/, '');
    addLog(`Starting sync: ${job.webdavPath || '/'} → ${startSmbPath || '(share root)'}`, 'info');
    await syncDir(job.webdavPath || '/', startSmbPath);
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


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────

// Interval presets → cron expressions
const INTERVAL_PRESETS = {
  '15min':  '*/15 * * * *',
  '30min':  '*/30 * * * *',
  '1hour':  '0 * * * *',
  '3hour':  '0 */3 * * *',
  '6hour':  '0 */6 * * *',
  '12hour': '0 */12 * * *',
  '24hour': '0 0 * * *',
  'manual': null,
};

// Map of jobId → node-cron task
const scheduledTasks = new Map();

function cronExprForJob(job) {
  if (!job.schedule || job.schedule === 'manual') return null;
  // If it's a preset key, look it up
  if (INTERVAL_PRESETS[job.schedule] !== undefined) return INTERVAL_PRESETS[job.schedule];
  // Otherwise treat it as a raw cron expression
  return job.schedule;
}

function describeSchedule(schedule) {
  const labels = {
    'manual':  'Manual only',
    '15min':   'Every 15 minutes',
    '30min':   'Every 30 minutes',
    '1hour':   'Every hour',
    '3hour':   'Every 3 hours',
    '6hour':   'Every 6 hours',
    '12hour':  'Every 12 hours',
    '24hour':  'Every 24 hours (daily)',
  };
  return labels[schedule] || `Custom: ${schedule}`;
}

function registerJobSchedule(job) {
  // Cancel any existing task for this job
  if (scheduledTasks.has(job.id)) {
    try { scheduledTasks.get(job.id).stop(); } catch (_) {}
    scheduledTasks.delete(job.id);
  }

  const expr = cronExprForJob(job);
  if (!expr) return; // manual — nothing to schedule

  if (!cron.validate(expr)) {
    console.error(`[scheduler] Invalid cron expression for job "${job.name}": ${expr}`);
    return;
  }

  const task = cron.schedule(expr, () => {
    const cfg = loadConfig();
    const current = cfg.syncJobs.find(j => j.id === job.id);
    if (!current) { task.stop(); scheduledTasks.delete(job.id); return; }
    if (current.status === 'running') {
      addLog(`Skipping scheduled run of "${current.name}" — already running`, 'warn');
      return;
    }
    addLog(`Scheduled run starting: "${current.name}" (${describeSchedule(current.schedule)})`, 'info');
    runSyncJob(job.id).catch(e => console.error('[scheduler error]', e.message));
  }, { scheduled: true, timezone: process.env.TZ || 'UTC' });

  scheduledTasks.set(job.id, task);
  console.log(`[scheduler] Registered "${job.name}" → ${expr}`);
}

function unregisterJobSchedule(jobId) {
  if (scheduledTasks.has(jobId)) {
    try { scheduledTasks.get(jobId).stop(); } catch (_) {}
    scheduledTasks.delete(jobId);
    console.log(`[scheduler] Unregistered job ${jobId}`);
  }
}

function initScheduler() {
  const cfg = loadConfig();
  const jobs = cfg.syncJobs || [];
  let count = 0;

  for (const job of jobs) {
    // Reset any stuck 'running' state from before restart
    if (job.status === 'running') {
      job.status = 'idle';
    }
    registerJobSchedule(job);
    if (cronExprForJob(job)) count++;
  }

  // Persist the status reset
  if (jobs.some(j => j.status === 'idle')) saveConfig(cfg);

  addLog(`Scheduler initialised: ${count} job(s) scheduled`, 'info');

  // Run scheduled jobs immediately on startup
  for (const job of jobs) {
    if (cronExprForJob(job)) {
      addLog(`Startup run: "${job.name}"`, 'info');
      setTimeout(() => {
        runSyncJob(job.id).catch(e => console.error('[startup run error]', e.message));
      }, 2000 + jobs.indexOf(job) * 1500); // stagger slightly
    }
  }
}

// Update job schedule endpoint
app.patch('/api/jobs/:id/schedule', (req, res) => {
  const { schedule } = req.body;
  const cfg = loadConfig();
  const idx = cfg.syncJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });

  // Validate custom cron
  if (schedule && schedule !== 'manual' && !INTERVAL_PRESETS[schedule]) {
    if (!cron.validate(schedule)) {
      return res.json({ success: false, message: `Invalid cron expression: "${schedule}"` });
    }
  }

  cfg.syncJobs[idx].schedule = schedule || 'manual';
  cfg.syncJobs[idx].nextRun = getNextRun(cfg.syncJobs[idx]);
  saveConfig(cfg);

  registerJobSchedule(cfg.syncJobs[idx]);
  broadcast({ type: 'jobUpdate', data: { id: req.params.id, schedule: cfg.syncJobs[idx].schedule, nextRun: cfg.syncJobs[idx].nextRun } });
  res.json({ success: true, schedule: cfg.syncJobs[idx].schedule });
});

// Validate a cron expression
app.post('/api/cron/validate', (req, res) => {
  const { expr } = req.body;
  if (!expr) return res.json({ valid: false, message: 'No expression provided' });
  const valid = cron.validate(expr);
  res.json({ valid, message: valid ? 'Valid cron expression' : 'Invalid cron expression' });
});

// Get presets
app.get('/api/cron/presets', (req, res) => {
  res.json(Object.entries(INTERVAL_PRESETS)
    .filter(([k]) => k !== 'manual')
    .map(([key, expr]) => ({ key, expr, label: describeSchedule(key) }))
  );
});

function getNextRun(job) {
  const expr = cronExprForJob(job);
  if (!expr) return null;
  try {
    // node-cron doesn't expose nextDate natively, approximate it
    const task = cron.schedule(expr, () => {}, { scheduled: false });
    // Return a rough estimate based on the expression
    return null; // node-cron v3 doesn't expose nextDate — use label only
  } catch (_) { return null; }
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
  // Start scheduler after a short delay to let the server settle
  setTimeout(initScheduler, 1000);
});
