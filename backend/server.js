const express = require('express');
const cors = require('cors');
const { createClient } = require('webdav');
const SMB2 = require('@marsaud/smb2');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const EventEmitter = require('events');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_FILE = '/data/config.json';
const LOG_FILE = '/data/sync.log';

// SSE clients
const sseClients = new Set();
const jobEmitter = new EventEmitter();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    webdav: { url: 'https://webdav.torbox.app', username: '', password: '' },
    smbShares: [],
    syncJobs: [],
    logs: []
  };
}

function saveConfig(config) {
  fs.mkdirSync('/data', { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function addLog(message, level = 'info') {
  const entry = { timestamp: new Date().toISOString(), level, message };
  const config = loadConfig();
  config.logs = config.logs || [];
  config.logs.unshift(entry);
  config.logs = config.logs.slice(0, 500); // Keep last 500
  saveConfig(config);
  broadcast({ type: 'log', data: entry });
  return entry;
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
});

// Get config
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

// Save WebDAV config
app.post('/api/webdav', (req, res) => {
  const config = loadConfig();
  config.webdav = req.body;
  saveConfig(config);
  res.json({ success: true });
});

// Test WebDAV connection
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

// Browse WebDAV
app.get('/api/webdav/browse', async (req, res) => {
  try {
    const config = loadConfig();
    const { url, username, password } = config.webdav;
    const dirPath = req.query.path || '/';
    const client = createClient(url, { username, password });
    const contents = await client.getDirectoryContents(dirPath);
    res.json({ success: true, contents: contents.map(f => ({
      name: f.basename,
      path: f.filename,
      type: f.type,
      size: f.size,
      lastmod: f.lastmod
    }))});
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Add SMB share
app.post('/api/smb', (req, res) => {
  const config = loadConfig();
  config.smbShares = config.smbShares || [];
  const share = { ...req.body, id: Date.now().toString() };
  config.smbShares.push(share);
  saveConfig(config);
  res.json({ success: true, share });
});

// Update SMB share
app.put('/api/smb/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.smbShares.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ success: false, message: 'Not found' });
  config.smbShares[idx] = { ...req.body, id: req.params.id };
  saveConfig(config);
  res.json({ success: true });
});

// Delete SMB share
app.delete('/api/smb/:id', (req, res) => {
  const config = loadConfig();
  config.smbShares = config.smbShares.filter(s => s.id !== req.params.id);
  saveConfig(config);
  res.json({ success: true });
});

// Test SMB connection
app.post('/api/smb/test', async (req, res) => {
  const { host, share, username, password, domain } = req.body;
  let smb2 = null;
  try {
    smb2 = new SMB2({
      share: `\\\\${host}\\${share}`,
      domain: domain || 'WORKGROUP',
      username,
      password,
      autoCloseTimeout: 5000
    });
    await new Promise((resolve, reject) => {
      smb2.readdir('', (err, files) => {
        if (err) reject(err);
        else resolve(files);
      });
    });
    res.json({ success: true, message: 'Connected successfully' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  } finally {
    if (smb2) try { smb2.close(); } catch(e) {}
  }
});

// Add sync job
app.post('/api/jobs', (req, res) => {
  const config = loadConfig();
  config.syncJobs = config.syncJobs || [];
  const job = {
    ...req.body,
    id: Date.now().toString(),
    status: 'idle',
    lastRun: null,
    filesCopied: 0
  };
  config.syncJobs.push(job);
  saveConfig(config);
  res.json({ success: true, job });
});

// Delete sync job
app.delete('/api/jobs/:id', (req, res) => {
  const config = loadConfig();
  config.syncJobs = config.syncJobs.filter(j => j.id !== req.params.id);
  saveConfig(config);
  res.json({ success: true });
});

// Run sync job
app.post('/api/jobs/:id/run', async (req, res) => {
  const config = loadConfig();
  const job = config.syncJobs.find(j => j.id === req.params.id);
  if (!job) return res.json({ success: false, message: 'Job not found' });
  if (job.status === 'running') return res.json({ success: false, message: 'Already running' });

  res.json({ success: true, message: 'Sync started' });
  runSyncJob(job.id);
});

async function runSyncJob(jobId) {
  const config = loadConfig();
  const jobIdx = config.syncJobs.findIndex(j => j.id === jobId);
  if (jobIdx === -1) return;

  const job = config.syncJobs[jobIdx];
  const smbShare = config.smbShares.find(s => s.id === job.smbShareId);
  if (!smbShare) {
    addLog(`Job "${job.name}": SMB share not found`, 'error');
    return;
  }

  // Mark running
  config.syncJobs[jobIdx].status = 'running';
  saveConfig(config);
  broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'running' } });
  addLog(`Starting sync job "${job.name}"`, 'info');

  let smb2 = null;
  let filesCopied = 0;
  let errors = 0;

  try {
    const { url, username: wUser, password: wPass } = config.webdav;
    const webdavClient = createClient(url, { username: wUser, password: wPass });

    smb2 = new SMB2({
      share: `\\\\${smbShare.host}\\${smbShare.share}`,
      domain: smbShare.domain || 'WORKGROUP',
      username: smbShare.username,
      password: smbShare.password,
      autoCloseTimeout: 30000
    });

    const smbReaddir = promisify(smb2.readdir.bind(smb2));
    const smbWriteFile = promisify(smb2.writeFile.bind(smb2));
    const smbMkdir = promisify(smb2.mkdir.bind(smb2));
    const smbExists = (p) => new Promise(resolve => {
      smb2.exists(p, (err, exists) => resolve(!err && exists));
    });

    const allowedExts = (job.fileTypes || []).map(e => e.toLowerCase().replace(/^\./, ''));

    async function syncDir(davPath, smbPath) {
      const contents = await webdavClient.getDirectoryContents(davPath);

      for (const item of contents) {
        const itemSmbPath = smbPath ? `${smbPath}\\${item.basename}` : item.basename;

        if (item.type === 'directory' && job.recursive) {
          try {
            const exists = await smbExists(itemSmbPath);
            if (!exists) await smbMkdir(itemSmbPath).catch(() => {});
          } catch(e) {}
          await syncDir(item.filename, itemSmbPath);
        } else if (item.type === 'file') {
          const ext = item.basename.split('.').pop()?.toLowerCase() || '';
          if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
            continue;
          }

          try {
            const exists = await smbExists(itemSmbPath);
            if (exists && !job.overwrite) {
              addLog(`Skipping (exists): ${item.filename}`, 'debug');
              continue;
            }

            addLog(`Copying: ${item.filename} → ${smbShare.host}/${smbShare.share}/${itemSmbPath}`, 'info');
            broadcast({ type: 'progress', data: { jobId, file: item.filename } });

            const fileBuffer = await webdavClient.getFileContents(item.filename);
            await smbWriteFile(itemSmbPath, fileBuffer);
            filesCopied++;
            broadcast({ type: 'filesCopied', data: { jobId, count: filesCopied } });
          } catch(e) {
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
    if (idx2 !== -1) {
      cfg2.syncJobs[idx2].status = 'error';
      cfg2.syncJobs[idx2].lastRun = new Date().toISOString();
      saveConfig(cfg2);
    }
    broadcast({ type: 'jobUpdate', data: { id: jobId, status: 'error' } });
  } finally {
    if (smb2) try { smb2.close(); } catch(e) {}
  }
}

// Get logs
app.get('/api/logs', (req, res) => {
  const config = loadConfig();
  res.json(config.logs || []);
});

// Clear logs
app.delete('/api/logs', (req, res) => {
  const config = loadConfig();
  config.logs = [];
  saveConfig(config);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  addLog('Server started', 'info');
});
