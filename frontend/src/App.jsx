import { useState, useEffect, useRef } from "react";

const API = "/api";

const FILE_TYPE_PRESETS = {
  "Video": ["mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "webm", "ts", "m2ts"],
  "Audio": ["mp3", "flac", "wav", "aac", "ogg", "m4a", "opus", "wma"],
  "Images": ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "raw", "heic"],
  "Documents": ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md"],
  "Archives": ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  "Subtitles": ["srt", "ass", "ssa", "sub", "vtt", "idx"],
};

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

function StatusDot({ status }) {
  const colors = {
    idle: "bg-slate-400",
    running: "bg-emerald-400 animate-pulse",
    error: "bg-red-400",
    success: "bg-emerald-400",
  };
  return <span className={cn("inline-block w-2 h-2 rounded-full", colors[status] || "bg-slate-400")} />;
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0f1117] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-white font-semibold text-lg">{title}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors text-xl leading-none">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, className }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <label className="text-xs text-white/50 uppercase tracking-widest font-medium">{label}</label>}
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60 focus:bg-white/8 transition-all"
      />
    </div>
  );
}

function Btn({ onClick, children, variant = "primary", size = "md", disabled, className }) {
  const base = "inline-flex items-center gap-2 font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-[#00d4aa] hover:bg-[#00bfa0] text-black",
    secondary: "bg-white/8 hover:bg-white/12 border border-white/10 text-white",
    danger: "bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400",
    ghost: "hover:bg-white/8 text-white/60 hover:text-white",
  };
  const sizes = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-5 py-2.5 text-base" };
  return (
    <button onClick={onClick} disabled={disabled} className={cn(base, variants[variant], sizes[size], className)}>
      {children}
    </button>
  );
}

function Badge({ children, color = "slate" }) {
  const colors = {
    slate: "bg-slate-500/20 text-slate-300 border-slate-500/30",
    green: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    red: "bg-red-500/20 text-red-300 border-red-500/30",
    yellow: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    blue: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium", colors[color])}>
      {children}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [config, setConfig] = useState(null);
  const [logs, setLogs] = useState([]);
  const [liveLogs, setLiveLogs] = useState([]);
  const [toast, setToast] = useState(null);
  const logsEndRef = useRef(null);

  // Modals
  const [smbModal, setSmbModal] = useState(false);
  const [editSmbId, setEditSmbId] = useState(null);
  const [jobModal, setJobModal] = useState(false);
  const [webdavModal, setWebdavModal] = useState(false);
  const [browseModal, setBrowseModal] = useState(false);
  const [browseItems, setBrowseItems] = useState([]);
  const [browsePath, setBrowsePath] = useState("/");
  const [browseCallback, setBrowseCallback] = useState(null);

  // Forms
  const [smbForm, setSmbForm] = useState({ name: "", host: "", share: "", username: "", password: "", domain: "WORKGROUP" });
  const [jobForm, setJobForm] = useState({ name: "", smbShareId: "", webdavPath: "/", smbDestPath: "", fileTypes: [], recursive: true, overwrite: false });
  const [webdavForm, setWebdavForm] = useState({ url: "https://webdav.torbox.app", username: "", password: "" });
  const [customFileType, setCustomFileType] = useState("");
  const [testStatus, setTestStatus] = useState({});

  const showToast = (msg, type = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchConfig = async () => {
    const r = await fetch(`${API}/config`);
    const d = await r.json();
    setConfig(d);
    setWebdavForm(d.webdav || { url: "https://webdav.torbox.app", username: "", password: "" });
  };

  const fetchLogs = async () => {
    const r = await fetch(`${API}/logs`);
    const d = await r.json();
    setLogs(d);
  };

  useEffect(() => {
    fetchConfig();
    fetchLogs();

    const es = new EventSource(`${API}/events`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "log") {
        setLiveLogs(prev => [data.data, ...prev].slice(0, 100));
        setLogs(prev => [data.data, ...prev].slice(0, 500));
      }
      if (data.type === "jobUpdate") {
        setConfig(prev => prev ? {
          ...prev,
          syncJobs: prev.syncJobs?.map(j =>
            j.id === data.data.id ? { ...j, ...data.data } : j
          )
        } : prev);
      }
    };
    return () => es.close();
  }, []);

  // SMB share form
  const handleSmbSubmit = async () => {
    const url = editSmbId ? `${API}/smb/${editSmbId}` : `${API}/smb`;
    const method = editSmbId ? "PUT" : "POST";
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(smbForm) });
    const d = await r.json();
    if (d.success) {
      showToast(editSmbId ? "Share updated" : "Share added", "success");
      setSmbModal(false);
      setEditSmbId(null);
      setSmbForm({ name: "", host: "", share: "", username: "", password: "", domain: "WORKGROUP" });
      fetchConfig();
    } else showToast(d.message, "error");
  };

  const handleDeleteSmb = async (id) => {
    if (!confirm("Delete this SMB share?")) return;
    await fetch(`${API}/smb/${id}`, { method: "DELETE" });
    showToast("Share deleted", "success");
    fetchConfig();
  };

  const handleTestSmb = async (share) => {
    setTestStatus(p => ({ ...p, [share.id || "new"]: "testing" }));
    const r = await fetch(`${API}/smb/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(share) });
    const d = await r.json();
    setTestStatus(p => ({ ...p, [share.id || "new"]: d.success ? "ok" : "fail" }));
    showToast(d.message, d.success ? "success" : "error");
  };

  const handleTestWebdav = async () => {
    setTestStatus(p => ({ ...p, webdav: "testing" }));
    const r = await fetch(`${API}/webdav/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webdavForm) });
    const d = await r.json();
    setTestStatus(p => ({ ...p, webdav: d.success ? "ok" : "fail" }));
    showToast(d.message, d.success ? "success" : "error");
  };

  const handleSaveWebdav = async () => {
    await fetch(`${API}/webdav`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webdavForm) });
    showToast("WebDAV settings saved", "success");
    fetchConfig();
    setWebdavModal(false);
  };

  const handleAddJob = async () => {
    const r = await fetch(`${API}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(jobForm) });
    const d = await r.json();
    if (d.success) {
      showToast("Sync job created", "success");
      setJobModal(false);
      setJobForm({ name: "", smbShareId: "", webdavPath: "/", smbDestPath: "", fileTypes: [], recursive: true, overwrite: false });
      fetchConfig();
    } else showToast(d.message, "error");
  };

  const handleDeleteJob = async (id) => {
    if (!confirm("Delete this sync job?")) return;
    await fetch(`${API}/jobs/${id}`, { method: "DELETE" });
    showToast("Job deleted", "success");
    fetchConfig();
  };

  const handleRunJob = async (id) => {
    const r = await fetch(`${API}/jobs/${id}/run`, { method: "POST" });
    const d = await r.json();
    showToast(d.message, d.success ? "info" : "error");
  };

  const toggleFileType = (ext) => {
    setJobForm(prev => ({
      ...prev,
      fileTypes: prev.fileTypes.includes(ext)
        ? prev.fileTypes.filter(e => e !== ext)
        : [...prev.fileTypes, ext]
    }));
  };

  const togglePreset = (exts) => {
    setJobForm(prev => {
      const allSelected = exts.every(e => prev.fileTypes.includes(e));
      return {
        ...prev,
        fileTypes: allSelected
          ? prev.fileTypes.filter(e => !exts.includes(e))
          : [...new Set([...prev.fileTypes, ...exts])]
      };
    });
  };

  const openBrowse = async (callback) => {
    setBrowseCallback(() => callback);
    setBrowsePath("/");
    setBrowseModal(true);
    const r = await fetch(`${API}/webdav/browse?path=/`);
    const d = await r.json();
    setBrowseItems(d.contents || []);
  };

  const navigateBrowse = async (p) => {
    setBrowsePath(p);
    const r = await fetch(`${API}/webdav/browse?path=${encodeURIComponent(p)}`);
    const d = await r.json();
    setBrowseItems(d.contents || []);
  };

  const formatSize = (bytes) => {
    if (!bytes) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  };

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "⬡" },
    { id: "webdav", label: "WebDAV", icon: "☁" },
    { id: "shares", label: "SMB Shares", icon: "🖧" },
    { id: "jobs", label: "Sync Jobs", icon: "⇄" },
    { id: "logs", label: "Logs", icon: "◈" },
  ];

  return (
    <div className="min-h-screen bg-[#080b10] text-white" style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace" }}>
      {/* Grid bg */}
      <div className="fixed inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(0,212,170,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,170,0.03) 1px, transparent 1px)",
        backgroundSize: "40px 40px"
      }} />

      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-56 bg-[#0a0d14]/90 border-r border-white/5 backdrop-blur-xl z-40 flex flex-col">
        <div className="px-5 py-6 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#00d4aa] flex items-center justify-center text-black text-xs font-bold">⇅</div>
            <div>
              <div className="text-white font-bold text-sm leading-none">WebDAV</div>
              <div className="text-[#00d4aa] text-xs mt-0.5">SMB Sync</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all text-left",
                tab === t.id
                  ? "bg-[#00d4aa]/15 text-[#00d4aa] border border-[#00d4aa]/20"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              )}
            >
              <span className="text-base">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="px-5 py-4 border-t border-white/5">
          <div className="text-white/20 text-xs">v1.0.0</div>
        </div>
      </aside>

      {/* Main */}
      <main className="ml-56 min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-[#080b10]/80 backdrop-blur-xl border-b border-white/5 px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-white text-lg font-bold capitalize">
                {tabs.find(t => t.id === tab)?.label}
              </h1>
              <p className="text-white/30 text-xs mt-0.5">WebDAV → SMB/CIFS File Sync</p>
            </div>
            {tab === "webdav" && (
              <Btn onClick={() => setWebdavModal(true)} size="sm">Configure WebDAV</Btn>
            )}
            {tab === "shares" && (
              <Btn onClick={() => { setEditSmbId(null); setSmbForm({ name: "", host: "", share: "", username: "", password: "", domain: "WORKGROUP" }); setSmbModal(true); }} size="sm">
                + Add Share
              </Btn>
            )}
            {tab === "jobs" && (
              <Btn onClick={() => setJobModal(true)} size="sm" disabled={!config?.smbShares?.length}>
                + New Job
              </Btn>
            )}
            {tab === "logs" && (
              <Btn onClick={async () => { await fetch(`${API}/logs`, { method: "DELETE" }); setLogs([]); }} variant="danger" size="sm">
                Clear Logs
              </Btn>
            )}
          </div>
        </header>

        <div className="px-8 py-6">

          {/* DASHBOARD */}
          {tab === "dashboard" && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "SMB Shares", value: config?.smbShares?.length || 0, icon: "🖧", color: "blue" },
                  { label: "Sync Jobs", value: config?.syncJobs?.length || 0, icon: "⇄", color: "green" },
                  { label: "Running Now", value: config?.syncJobs?.filter(j => j.status === "running").length || 0, icon: "▶", color: "yellow" },
                ].map(s => (
                  <div key={s.label} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-white/40 text-xs uppercase tracking-widest">{s.label}</span>
                      <span className="text-xl">{s.icon}</span>
                    </div>
                    <div className="text-4xl font-bold text-white">{s.value}</div>
                  </div>
                ))}
              </div>

              {/* WebDAV status */}
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/60 text-xs uppercase tracking-widest mb-3">WebDAV Source</h3>
                <div className="flex items-center gap-3">
                  <StatusDot status={config?.webdav?.username ? "success" : "idle"} />
                  <span className="text-white/80 text-sm">{config?.webdav?.url || "Not configured"}</span>
                  {config?.webdav?.username && <Badge color="green">{config.webdav.username}</Badge>}
                </div>
              </div>

              {/* Recent jobs */}
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/60 text-xs uppercase tracking-widest mb-4">Sync Jobs</h3>
                {!config?.syncJobs?.length ? (
                  <p className="text-white/30 text-sm">No jobs configured yet.</p>
                ) : (
                  <div className="space-y-3">
                    {config.syncJobs.map(job => {
                      const share = config.smbShares?.find(s => s.id === job.smbShareId);
                      return (
                        <div key={job.id} className="flex items-center justify-between bg-white/3 rounded-xl px-4 py-3">
                          <div className="flex items-center gap-3">
                            <StatusDot status={job.status} />
                            <div>
                              <div className="text-white text-sm font-medium">{job.name}</div>
                              <div className="text-white/30 text-xs">{job.webdavPath} → {share?.name || "?"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {job.filesCopied > 0 && <Badge color="green">{job.filesCopied} files</Badge>}
                            <Btn onClick={() => handleRunJob(job.id)} variant="secondary" size="sm" disabled={job.status === "running"}>
                              {job.status === "running" ? "Running…" : "▶ Run"}
                            </Btn>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Live log tail */}
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/60 text-xs uppercase tracking-widest mb-3">Live Activity</h3>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {liveLogs.length === 0 && <p className="text-white/20 text-xs">No recent activity.</p>}
                  {liveLogs.slice(0, 15).map((l, i) => (
                    <div key={i} className="flex gap-2 text-xs">
                      <span className="text-white/20 shrink-0">{new Date(l.timestamp).toLocaleTimeString()}</span>
                      <span className={cn(l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-yellow-400" : "text-white/50")}>
                        {l.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* WEBDAV */}
          {tab === "webdav" && (
            <div className="space-y-4 max-w-xl">
              <div className="bg-white/3 border border-white/8 rounded-2xl p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <StatusDot status={config?.webdav?.username ? "success" : "idle"} />
                  <div>
                    <div className="text-white font-medium">{config?.webdav?.url || "Not configured"}</div>
                    <div className="text-white/40 text-xs">{config?.webdav?.username ? `Logged in as ${config.webdav.username}` : "No credentials set"}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Btn onClick={() => setWebdavModal(true)}>Configure</Btn>
                  {config?.webdav?.username && (
                    <Btn variant="secondary" onClick={() => openBrowse(() => {})}>Browse Files</Btn>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* SMB SHARES */}
          {tab === "shares" && (
            <div className="space-y-3">
              {!config?.smbShares?.length && (
                <div className="bg-white/3 border border-white/8 rounded-2xl p-8 text-center">
                  <div className="text-white/20 text-4xl mb-3">🖧</div>
                  <p className="text-white/40 text-sm">No SMB shares configured yet.</p>
                  <p className="text-white/25 text-xs mt-1">Add a share to get started.</p>
                </div>
              )}
              {config?.smbShares?.map(share => (
                <div key={share.id} className="bg-white/3 border border-white/8 rounded-2xl px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-9 h-9 rounded-lg bg-blue-500/20 border border-blue-500/20 flex items-center justify-center text-blue-400 text-sm">🖧</div>
                    <div>
                      <div className="text-white font-medium">{share.name}</div>
                      <div className="text-white/40 text-xs">{share.username}@{share.host}\{share.share}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {testStatus[share.id] && (
                      <Badge color={testStatus[share.id] === "ok" ? "green" : testStatus[share.id] === "fail" ? "red" : "slate"}>
                        {testStatus[share.id] === "testing" ? "testing…" : testStatus[share.id] === "ok" ? "✓ connected" : "✗ failed"}
                      </Badge>
                    )}
                    <Btn variant="secondary" size="sm" onClick={() => handleTestSmb(share)}>Test</Btn>
                    <Btn variant="secondary" size="sm" onClick={() => {
                      setEditSmbId(share.id);
                      setSmbForm({ ...share });
                      setSmbModal(true);
                    }}>Edit</Btn>
                    <Btn variant="danger" size="sm" onClick={() => handleDeleteSmb(share.id)}>Delete</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* JOBS */}
          {tab === "jobs" && (
            <div className="space-y-3">
              {!config?.smbShares?.length && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl px-4 py-3 text-yellow-400 text-sm">
                  ⚠ You need at least one SMB share before creating sync jobs.
                </div>
              )}
              {!config?.syncJobs?.length && (
                <div className="bg-white/3 border border-white/8 rounded-2xl p-8 text-center">
                  <div className="text-white/20 text-4xl mb-3">⇄</div>
                  <p className="text-white/40 text-sm">No sync jobs yet.</p>
                </div>
              )}
              {config?.syncJobs?.map(job => {
                const share = config.smbShares?.find(s => s.id === job.smbShareId);
                return (
                  <div key={job.id} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <StatusDot status={job.status} />
                        <div>
                          <div className="text-white font-medium">{job.name}</div>
                          <div className="text-white/40 text-xs mt-0.5">
                            {job.webdavPath} → {share?.name || "Unknown Share"} / {job.smbDestPath || "(root)"}
                          </div>
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            {job.fileTypes?.map(e => <Badge key={e} color="blue">.{e}</Badge>)}
                            {!job.fileTypes?.length && <Badge color="slate">All files</Badge>}
                            {job.recursive && <Badge color="slate">Recursive</Badge>}
                            {job.overwrite && <Badge color="yellow">Overwrite</Badge>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {job.lastRun && <span className="text-white/25 text-xs">{new Date(job.lastRun).toLocaleDateString()}</span>}
                        <Btn onClick={() => handleRunJob(job.id)} size="sm" disabled={job.status === "running"}>
                          {job.status === "running" ? "Running…" : "▶ Run"}
                        </Btn>
                        <Btn variant="danger" size="sm" onClick={() => handleDeleteJob(job.id)}>✕</Btn>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* LOGS */}
          {tab === "logs" && (
            <div className="bg-[#060810] border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                <span className="text-white/40 text-xs uppercase tracking-widest">System Logs</span>
                <span className="text-white/20 text-xs">{logs.length} entries</span>
              </div>
              <div className="max-h-[600px] overflow-y-auto p-4 space-y-0.5">
                {!logs.length && <p className="text-white/20 text-xs p-2">No logs yet.</p>}
                {logs.map((l, i) => (
                  <div key={i} className="flex gap-3 py-1 border-b border-white/3 text-xs">
                    <span className="text-white/20 shrink-0 w-36">{new Date(l.timestamp).toLocaleString()}</span>
                    <span className={cn(
                      "shrink-0 w-10 font-bold uppercase",
                      l.level === "error" ? "text-red-400" :
                      l.level === "warn" ? "text-yellow-400" :
                      l.level === "debug" ? "text-white/25" :
                      "text-[#00d4aa]/60"
                    )}>{l.level}</span>
                    <span className={cn("break-all", l.level === "error" ? "text-red-300" : "text-white/50")}>{l.message}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
        </div>
      </main>

      {/* WEBDAV MODAL */}
      <Modal open={webdavModal} onClose={() => setWebdavModal(false)} title="WebDAV Configuration">
        <div className="space-y-4">
          <Input label="Server URL" value={webdavForm.url} onChange={v => setWebdavForm(p => ({ ...p, url: v }))} placeholder="https://webdav.torbox.app" />
          <Input label="Username" value={webdavForm.username} onChange={v => setWebdavForm(p => ({ ...p, username: v }))} />
          <Input label="Password" type="password" value={webdavForm.password} onChange={v => setWebdavForm(p => ({ ...p, password: v }))} />
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSaveWebdav}>Save</Btn>
            <Btn variant="secondary" onClick={handleTestWebdav}>
              {testStatus.webdav === "testing" ? "Testing…" : "Test Connection"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* SMB MODAL */}
      <Modal open={smbModal} onClose={() => { setSmbModal(false); setEditSmbId(null); }} title={editSmbId ? "Edit SMB Share" : "Add SMB Share"}>
        <div className="space-y-4">
          <Input label="Name" value={smbForm.name} onChange={v => setSmbForm(p => ({ ...p, name: v }))} placeholder="My NAS" />
          <Input label="Host / IP" value={smbForm.host} onChange={v => setSmbForm(p => ({ ...p, host: v }))} placeholder="192.168.1.100" />
          <Input label="Share Name" value={smbForm.share} onChange={v => setSmbForm(p => ({ ...p, share: v }))} placeholder="media" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Username" value={smbForm.username} onChange={v => setSmbForm(p => ({ ...p, username: v }))} />
            <Input label="Password" type="password" value={smbForm.password} onChange={v => setSmbForm(p => ({ ...p, password: v }))} />
          </div>
          <Input label="Domain" value={smbForm.domain} onChange={v => setSmbForm(p => ({ ...p, domain: v }))} placeholder="WORKGROUP" />
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSmbSubmit}>{editSmbId ? "Save Changes" : "Add Share"}</Btn>
            <Btn variant="secondary" onClick={() => handleTestSmb(smbForm)}>
              {testStatus["new"] === "testing" ? "Testing…" : "Test Connection"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* JOB MODAL */}
      <Modal open={jobModal} onClose={() => setJobModal(false)} title="New Sync Job">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <Input label="Job Name" value={jobForm.name} onChange={v => setJobForm(p => ({ ...p, name: v }))} placeholder="Copy Movies" />

          <div>
            <label className="text-xs text-white/50 uppercase tracking-widest font-medium">SMB Destination</label>
            <select
              value={jobForm.smbShareId}
              onChange={e => setJobForm(p => ({ ...p, smbShareId: e.target.value }))}
              className="mt-1.5 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#00d4aa]/60"
            >
              <option value="">Select a share…</option>
              {config?.smbShares?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host}\{s.share})</option>)}
            </select>
          </div>

          <div className="flex gap-2 items-end">
            <Input label="WebDAV Source Path" value={jobForm.webdavPath} onChange={v => setJobForm(p => ({ ...p, webdavPath: v }))} placeholder="/" className="flex-1" />
            <Btn variant="secondary" size="sm" onClick={() => openBrowse((p) => { setJobForm(prev => ({ ...prev, webdavPath: p })); setBrowseModal(false); })}>Browse</Btn>
          </div>

          <Input label="SMB Destination Path (optional)" value={jobForm.smbDestPath} onChange={v => setJobForm(p => ({ ...p, smbDestPath: v }))} placeholder="downloads\movies" />

          {/* File types */}
          <div>
            <label className="text-xs text-white/50 uppercase tracking-widest font-medium block mb-2">File Types</label>
            <div className="space-y-2">
              {Object.entries(FILE_TYPE_PRESETS).map(([preset, exts]) => (
                <div key={preset}>
                  <div className="flex items-center gap-2 mb-1">
                    <button
                      onClick={() => togglePreset(exts)}
                      className={cn(
                        "text-xs px-2 py-1 rounded font-medium border transition-all",
                        exts.every(e => jobForm.fileTypes.includes(e))
                          ? "bg-[#00d4aa]/20 border-[#00d4aa]/40 text-[#00d4aa]"
                          : "bg-white/5 border-white/10 text-white/40 hover:text-white/70"
                      )}
                    >{preset}</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-2">
                    {exts.map(ext => (
                      <button
                        key={ext}
                        onClick={() => toggleFileType(ext)}
                        className={cn(
                          "text-xs px-2 py-0.5 rounded border transition-all",
                          jobForm.fileTypes.includes(ext)
                            ? "bg-[#00d4aa]/15 border-[#00d4aa]/30 text-[#00d4aa]"
                            : "bg-white/3 border-white/8 text-white/30 hover:text-white/60"
                        )}
                      >.{ext}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Custom type */}
            <div className="flex gap-2 mt-3">
              <Input value={customFileType} onChange={setCustomFileType} placeholder="custom ext (e.g. nfo)" className="flex-1" />
              <Btn variant="secondary" size="sm" onClick={() => {
                if (customFileType.trim()) {
                  const ext = customFileType.trim().toLowerCase().replace(/^\./, "");
                  setJobForm(p => ({ ...p, fileTypes: [...new Set([...p.fileTypes, ext])] }));
                  setCustomFileType("");
                }
              }}>Add</Btn>
            </div>

            {jobForm.fileTypes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {jobForm.fileTypes.map(ext => (
                  <span key={ext} className="inline-flex items-center gap-1 bg-[#00d4aa]/10 border border-[#00d4aa]/20 text-[#00d4aa] text-xs px-2 py-0.5 rounded-full">
                    .{ext}
                    <button onClick={() => toggleFileType(ext)} className="text-[#00d4aa]/60 hover:text-[#00d4aa]">×</button>
                  </span>
                ))}
              </div>
            )}
            {jobForm.fileTypes.length === 0 && (
              <p className="text-white/25 text-xs mt-2">No filter — all file types will be copied.</p>
            )}
          </div>

          {/* Options */}
          <div className="space-y-2">
            <label className="text-xs text-white/50 uppercase tracking-widest font-medium block">Options</label>
            {[
              { key: "recursive", label: "Recursive (include subdirectories)" },
              { key: "overwrite", label: "Overwrite existing files" },
            ].map(opt => (
              <label key={opt.key} className="flex items-center gap-2.5 cursor-pointer group">
                <div
                  onClick={() => setJobForm(p => ({ ...p, [opt.key]: !p[opt.key] }))}
                  className={cn(
                    "w-4 h-4 rounded border flex items-center justify-center transition-all",
                    jobForm[opt.key] ? "bg-[#00d4aa] border-[#00d4aa]" : "bg-white/5 border-white/20 group-hover:border-white/40"
                  )}
                >
                  {jobForm[opt.key] && <span className="text-black text-xs">✓</span>}
                </div>
                <span className="text-white/60 text-sm">{opt.label}</span>
              </label>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <Btn onClick={handleAddJob} disabled={!jobForm.name || !jobForm.smbShareId}>Create Job</Btn>
            <Btn variant="secondary" onClick={() => setJobModal(false)}>Cancel</Btn>
          </div>
        </div>
      </Modal>

      {/* BROWSE MODAL */}
      <Modal open={browseModal} onClose={() => setBrowseModal(false)} title="Browse WebDAV">
        <div className="space-y-3">
          <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
            <span className="text-white/30 text-xs">Path:</span>
            <span className="text-[#00d4aa] text-xs">{browsePath}</span>
          </div>
          {browsePath !== "/" && (
            <button
              onClick={() => navigateBrowse(browsePath.split("/").slice(0, -1).join("/") || "/")}
              className="flex items-center gap-2 text-white/40 hover:text-white text-sm transition-colors"
            >
              ← ..
            </button>
          )}
          <div className="max-h-72 overflow-y-auto space-y-1">
            {browseItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between hover:bg-white/5 rounded-lg px-3 py-2 transition-colors">
                <div className="flex items-center gap-2">
                  <span>{item.type === "directory" ? "📁" : "📄"}</span>
                  <span className="text-white/70 text-sm">{item.name}</span>
                  {item.size > 0 && <span className="text-white/25 text-xs">{formatSize(item.size)}</span>}
                </div>
                <div className="flex gap-1">
                  {item.type === "directory" && (
                    <Btn variant="ghost" size="sm" onClick={() => navigateBrowse(item.path)}>Open</Btn>
                  )}
                  <Btn variant="secondary" size="sm" onClick={() => { browseCallback && browseCallback(item.path); setBrowseModal(false); }}>
                    Select
                  </Btn>
                </div>
              </div>
            ))}
          </div>
          <Btn onClick={() => { browseCallback && browseCallback(browsePath); setBrowseModal(false); }} className="w-full justify-center">
            Select Current Directory: {browsePath}
          </Btn>
        </div>
      </Modal>

      {/* Toast */}
      {toast && (
        <div className={cn(
          "fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-xl border transition-all",
          toast.type === "error" ? "bg-red-900/80 border-red-500/30 text-red-200" :
          toast.type === "success" ? "bg-emerald-900/80 border-emerald-500/30 text-emerald-200" :
          "bg-slate-800/90 border-white/10 text-white/80"
        )}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
