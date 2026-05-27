import { useState, useEffect, useRef, useCallback } from "react";

const API = "/api";

const INTERVAL_PRESETS = [
  { key: "manual",  label: "Manual only",           icon: "—"  },
  { key: "15min",   label: "Every 15 minutes",       icon: "⚡" },
  { key: "30min",   label: "Every 30 minutes",       icon: "🔄" },
  { key: "1hour",   label: "Every hour",             icon: "🕐" },
  { key: "3hour",   label: "Every 3 hours",          icon: "🕒" },
  { key: "6hour",   label: "Every 6 hours",          icon: "🕕" },
  { key: "12hour",  label: "Every 12 hours",         icon: "🕛" },
  { key: "24hour",  label: "Every 24 hours (daily)", icon: "📅" },
  { key: "custom",  label: "Custom cron…",           icon: "⚙️" },
];

function scheduleLabel(schedule) {
  if (!schedule || schedule === "manual") return "Manual only";
  const preset = INTERVAL_PRESETS.find(p => p.key === schedule);
  if (preset) return preset.label;
  return `Cron: ${schedule}`;
}

const FILE_TYPE_PRESETS = {
  "Video":     ["mp4","mkv","avi","mov","wmv","flv","m4v","webm","ts","m2ts"],
  "Audio":     ["mp3","flac","wav","aac","ogg","m4a","opus","wma"],
  "Images":    ["jpg","jpeg","png","gif","webp","bmp","tiff","raw","heic"],
  "Documents": ["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md"],
  "Archives":  ["zip","rar","7z","tar","gz","bz2","xz"],
  "Subtitles": ["srt","ass","ssa","sub","vtt","idx"],
};

function cn(...c) { return c.filter(Boolean).join(" "); }

function formatSize(b) {
  if (!b || b === 0) return "—";
  if (b < 1024) return b + " B";
  if (b < 1024*1024) return (b/1024).toFixed(1) + " KB";
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + " MB";
  return (b/1024/1024/1024).toFixed(2) + " GB";
}

function formatDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

// ── Primitives ────────────────────────────────────────────────────────────────
function StatusDot({ status }) {
  const c = { idle:"bg-slate-500", ok:"bg-emerald-400", running:"bg-emerald-400 animate-pulse", error:"bg-red-400", unknown:"bg-slate-600" };
  return <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", c[status]||"bg-slate-600")} />;
}

function Badge({ children, color="slate" }) {
  const c = { slate:"bg-slate-500/20 text-slate-300 border-slate-500/30", green:"bg-emerald-500/20 text-emerald-300 border-emerald-500/30", red:"bg-red-500/20 text-red-300 border-red-500/30", yellow:"bg-yellow-500/20 text-yellow-300 border-yellow-500/30", blue:"bg-blue-500/20 text-blue-300 border-blue-500/30", teal:"bg-teal-500/20 text-teal-300 border-teal-500/30" };
  return <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium", c[color]||c.slate)}>{children}</span>;
}

function Btn({ onClick, children, variant="primary", size="md", disabled, className }) {
  const base = "inline-flex items-center gap-1.5 font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed select-none";
  const v = { primary:"bg-[#00d4aa] hover:bg-[#00bfa0] text-black", secondary:"bg-white/8 hover:bg-white/12 border border-white/10 text-white", danger:"bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400", ghost:"hover:bg-white/8 text-white/50 hover:text-white" };
  const s = { sm:"px-2.5 py-1.5 text-xs", md:"px-4 py-2 text-sm", lg:"px-5 py-2.5 text-base" };
  return <button onClick={onClick} disabled={disabled} className={cn(base,v[variant]||v.secondary,s[size],className)}>{children}</button>;
}

function Input({ label, value, onChange, type="text", placeholder, className }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <label className="text-xs text-white/40 uppercase tracking-widest font-medium">{label}</label>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60 transition-all" />
    </div>
  );
}

function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className={cn("relative bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl flex flex-col", wide ? "w-full max-w-4xl max-h-[90vh]" : "w-full max-w-lg")}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8 shrink-0">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white text-xl leading-none transition-colors">×</button>
        </div>
        <div className="overflow-y-auto flex-1 p-6">{children}</div>
      </div>
    </div>
  );
}

// ── File browser component ────────────────────────────────────────────────────
function FileBrowser({ title, items, loading, error, currentPath, onNavigate, onSelect, selectLabel="Select", showFiles=true }) {
  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-1 py-2 shrink-0 flex-wrap">
        <button onClick={() => onNavigate('/')} className="text-[#00d4aa] hover:text-[#00bfa0] text-xs transition-colors">root</button>
        {pathParts.map((part, i) => {
          const to = '/' + pathParts.slice(0, i+1).join('/');
          return (
            <span key={i} className="flex items-center gap-1">
              <span className="text-white/20 text-xs">/</span>
              <button onClick={() => onNavigate(to)} className="text-[#00d4aa] hover:text-[#00bfa0] text-xs transition-colors">{part}</button>
            </span>
          );
        })}
      </div>

      {/* Back button */}
      {currentPath !== '/' && (
        <button onClick={() => {
          const parent = '/' + pathParts.slice(0, -1).join('/');
          onNavigate(parent || '/');
        }} className="flex items-center gap-2 px-2 py-1.5 text-white/40 hover:text-white/70 text-sm hover:bg-white/5 rounded transition-all mx-1 mb-1">
          <span>←</span><span>..</span>
        </button>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 border border-white/8 rounded-xl">
        {loading && (
          <div className="flex items-center justify-center h-32 text-white/30 text-sm">
            <span className="animate-pulse">Loading…</span>
          </div>
        )}
        {error && !loading && (
          <div className="flex items-center justify-center h-32 text-red-400 text-sm px-4 text-center">{error}</div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="flex items-center justify-center h-32 text-white/20 text-sm">Empty directory</div>
        )}
        {!loading && !error && items.map((item, i) => (
          <div key={i} className={cn("flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0", !showFiles && item.type==='file' && "opacity-30 pointer-events-none")}>
            <span className="text-base shrink-0">{item.type==='directory' ? '📁' : '📄'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-white/80 text-sm truncate">{item.name}</div>
              <div className="text-white/25 text-xs">{item.type==='file' ? formatSize(item.size) : 'folder'}{item.lastmod ? ` · ${formatDate(item.lastmod)}` : ''}</div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              {item.type==='directory' && (
                <Btn variant="ghost" size="sm" onClick={() => onNavigate(item.path)}>Open</Btn>
              )}
              {onSelect && (
                <Btn variant="secondary" size="sm" onClick={() => onSelect(item)}>
                  {item.type==='directory' ? selectLabel : 'Select'}
                </Btn>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Select current dir */}
      {onSelect && currentPath && (
        <div className="pt-3 shrink-0">
          <Btn onClick={() => onSelect({ path: currentPath, type: 'directory', name: pathParts[pathParts.length-1] || 'root' })} className="w-full justify-center">
            Use: {currentPath}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [config, setConfig] = useState(null);
  const [logs, setLogs] = useState([]);
  const [liveLogs, setLiveLogs] = useState([]);
  const [toast, setToast] = useState(null);
  const [sseConnected, setSseConnected] = useState(false);

  // Modals
  const [smbModal, setSmbModal] = useState(false);
  const [editSmbId, setEditSmbId] = useState(null);
  const [jobModal, setJobModal] = useState(false);
  const [editJobId, setEditJobId] = useState(null);
  const [webdavModal, setWebdavModal] = useState(false);

  // Browser modals
  const [davBrowserOpen, setDavBrowserOpen] = useState(false);
  const [davBrowserCallback, setDavBrowserCallback] = useState(null);
  const [davBrowserPath, setDavBrowserPath] = useState('/');
  const [davBrowserItems, setDavBrowserItems] = useState([]);
  const [davBrowserLoading, setDavBrowserLoading] = useState(false);
  const [davBrowserError, setDavBrowserError] = useState(null);

  const [smbBrowserOpen, setSmbBrowserOpen] = useState(false);
  const [smbBrowserShareId, setSmbBrowserShareId] = useState(null);
  const [smbBrowserCallback, setSmbBrowserCallback] = useState(null);
  const [smbBrowserPath, setSmbBrowserPath] = useState('/');
  const [smbBrowserItems, setSmbBrowserItems] = useState([]);
  const [smbBrowserLoading, setSmbBrowserLoading] = useState(false);
  const [smbBrowserError, setSmbBrowserError] = useState(null);

  // File browser tabs in shares page
  const [sharesBrowseId, setSharesBrowseId] = useState(null);
  const [sharesBrowsePath, setSharesBrowsePath] = useState('/');
  const [sharesBrowseItems, setSharesBrowseItems] = useState([]);
  const [sharesBrowseLoading, setSharesBrowseLoading] = useState(false);
  const [sharesBrowseError, setSharesBrowseError] = useState(null);

  // WebDAV browse tab state
  const [davTabPath, setDavTabPath] = useState('/');
  const [davTabItems, setDavTabItems] = useState([]);
  const [davTabLoading, setDavTabLoading] = useState(false);
  const [davTabError, setDavTabError] = useState(null);

  // Forms
  const [smbForm, setSmbForm] = useState({ name:"", host:"", share:"", username:"", password:"", domain:"WORKGROUP" });
  const [jobForm, setJobForm] = useState({ name:"", smbShareId:"", webdavPath:"/", smbDestPath:"", fileTypes:[], recursive:true, overwrite:false, schedule:"manual" });
  const [webdavForm, setWebdavForm] = useState({ url:"https://webdav.torbox.app", username:"", password:"" });
  const [customExt, setCustomExt] = useState("");
  const [cronInput, setCronInput] = useState("");
  const [cronValid, setCronValid] = useState(null);
  const [testStatus, setTestStatus] = useState({});

  const showToast = (msg, type="info") => { setToast({msg,type}); setTimeout(()=>setToast(null),3500); };

  const fetchConfig = useCallback(async () => {
    const r = await fetch(`${API}/config`);
    const d = await r.json();
    setConfig(d);
    if (d.webdav) setWebdavForm(d.webdav);
  }, []);

  const fetchLogs = useCallback(async () => {
    const r = await fetch(`${API}/logs`);
    setLogs(await r.json());
  }, []);

  // SSE
  useEffect(() => {
    fetchConfig();
    fetchLogs();
    let es;
    function connect() {
      es = new EventSource(`${API}/events`);
      es.onopen = () => setSseConnected(true);
      es.onerror = () => { setSseConnected(false); setTimeout(connect, 3000); };
      es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') setSseConnected(true);
        if (data.type === 'log') {
          setLiveLogs(p => [data.data, ...p].slice(0, 100));
          setLogs(p => [data.data, ...p].slice(0, 500));
        }
        if (data.type === 'jobUpdate') {
          setConfig(p => p ? { ...p, syncJobs: p.syncJobs?.map(j => j.id === data.data.id ? { ...j, ...data.data } : j) } : p);
        }
      };
    }
    connect();
    return () => { if (es) es.close(); };
  }, []);

  // ── WebDAV tab browse ───────────────────────────────────────────────────────
  const loadDavTab = useCallback(async (p) => {
    setDavTabPath(p); setDavTabLoading(true); setDavTabError(null);
    try {
      const r = await fetch(`${API}/webdav/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (d.success) setDavTabItems(d.contents || []);
      else setDavTabError(d.message);
    } catch (e) { setDavTabError(e.message); }
    setDavTabLoading(false);
  }, []);

  useEffect(() => { if (tab === 'webdav' && config?.webdav?.username) loadDavTab('/'); }, [tab]);

  // ── DAV browser modal ───────────────────────────────────────────────────────
  const loadDavBrowser = useCallback(async (p) => {
    setDavBrowserPath(p); setDavBrowserLoading(true); setDavBrowserError(null);
    try {
      const r = await fetch(`${API}/webdav/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (d.success) setDavBrowserItems(d.contents || []);
      else setDavBrowserError(d.message);
    } catch (e) { setDavBrowserError(e.message); }
    setDavBrowserLoading(false);
  }, []);

  const openDavBrowser = (cb) => {
    setDavBrowserCallback(() => cb);
    setDavBrowserOpen(true);
    loadDavBrowser('/');
  };

  // ── SMB browser modal ───────────────────────────────────────────────────────
  const loadSmbBrowser = useCallback(async (shareId, p) => {
    setSmbBrowserPath(p); setSmbBrowserLoading(true); setSmbBrowserError(null);
    try {
      const r = await fetch(`${API}/smb/${shareId}/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (d.success) setSmbBrowserItems(d.contents || []);
      else setSmbBrowserError(d.message);
    } catch (e) { setSmbBrowserError(e.message); }
    setSmbBrowserLoading(false);
  }, []);

  const openSmbBrowser = (shareId, cb) => {
    setSmbBrowserShareId(shareId);
    setSmbBrowserCallback(() => cb);
    setSmbBrowserOpen(true);
    loadSmbBrowser(shareId, '/');
  };

  // ── Shares page inline browser ──────────────────────────────────────────────
  const loadSharesBrowse = useCallback(async (shareId, p) => {
    setSharesBrowsePath(p); setSharesBrowseLoading(true); setSharesBrowseError(null);
    try {
      const r = await fetch(`${API}/smb/${shareId}/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (d.success) setSharesBrowseItems(d.contents || []);
      else setSharesBrowseError(d.message);
    } catch (e) { setSharesBrowseError(e.message); }
    setSharesBrowseLoading(false);
  }, []);

  const openSharesBrowse = (shareId) => {
    if (sharesBrowseId === shareId) { setSharesBrowseId(null); return; }
    setSharesBrowseId(shareId);
    loadSharesBrowse(shareId, '/');
  };

  // ── SMB CRUD ────────────────────────────────────────────────────────────────
  const handleSmbSubmit = async () => {
    const url = editSmbId ? `${API}/smb/${editSmbId}` : `${API}/smb`;
    const method = editSmbId ? "PUT" : "POST";
    const r = await fetch(url, { method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(smbForm) });
    const d = await r.json();
    if (d.success) { showToast(editSmbId?"Share updated":"Share added","success"); setSmbModal(false); setEditSmbId(null); setSmbForm({name:"",host:"",share:"",username:"",password:"",domain:"WORKGROUP"}); fetchConfig(); }
    else showToast(d.message,"error");
  };

  const handleDeleteSmb = async (id) => {
    if (!confirm("Delete this SMB share? Any jobs using it will break.")) return;
    await fetch(`${API}/smb/${id}`, { method:"DELETE" });
    showToast("Share deleted","success");
    if (sharesBrowseId === id) setSharesBrowseId(null);
    fetchConfig();
  };

  const handleTestSmb = async (share) => {
    const key = share.id || "new";
    setTestStatus(p => ({ ...p, [key]:"testing" }));
    const r = await fetch(`${API}/smb/test`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(share) });
    const d = await r.json();
    setTestStatus(p => ({ ...p, [key]: d.success?"ok":"fail" }));
    showToast(d.message, d.success?"success":"error");
    if (d.success || !d.success) fetchConfig(); // refresh lastStatus
  };

  const handleTestWebdav = async () => {
    setTestStatus(p => ({...p, webdav:"testing"}));
    const r = await fetch(`${API}/webdav/test`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(webdavForm) });
    const d = await r.json();
    setTestStatus(p => ({...p, webdav: d.success?"ok":"fail"}));
    showToast(d.message, d.success?"success":"error");
  };

  const handleSaveWebdav = async () => {
    await fetch(`${API}/webdav`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(webdavForm) });
    showToast("WebDAV settings saved","success");
    fetchConfig();
    setWebdavModal(false);
  };

  // ── Job CRUD ────────────────────────────────────────────────────────────────
  const handleAddJob = async () => {
    const url = editJobId ? `${API}/jobs/${editJobId}` : `${API}/jobs`;
    const method = editJobId ? "PUT" : "POST";
    const r = await fetch(url, { method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(jobForm) });
    const d = await r.json();
    if (d.success) {
      showToast(editJobId?"Job updated":"Sync job created","success");
      setJobModal(false); setEditJobId(null);
      setJobForm({name:"",smbShareId:"",webdavPath:"/",smbDestPath:"",fileTypes:[],recursive:true,overwrite:false});
      fetchConfig();
    } else showToast(d.message,"error");
  };

  const handleDeleteJob = async (id) => {
    if (!confirm("Delete this sync job?")) return;
    await fetch(`${API}/jobs/${id}`, { method:"DELETE" });
    showToast("Job deleted","success"); fetchConfig();
  };

  const handleRunJob = async (id) => {
    const r = await fetch(`${API}/jobs/${id}/run`, { method:"POST" });
    const d = await r.json();
    showToast(d.message, d.success?"info":"error");
  };

  const validateCron = async (expr) => {
    if (!expr.trim()) { setCronValid(null); return; }
    try {
      const r = await fetch(`${API}/cron/validate`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ expr }) });
      const d = await r.json();
      setCronValid(d.valid);
    } catch { setCronValid(false); }
  };

  const toggleFileType = (ext) => setJobForm(p => ({ ...p, fileTypes: p.fileTypes.includes(ext) ? p.fileTypes.filter(e=>e!==ext) : [...p.fileTypes, ext] }));
  const togglePreset = (exts) => setJobForm(p => { const all = exts.every(e=>p.fileTypes.includes(e)); return {...p, fileTypes: all ? p.fileTypes.filter(e=>!exts.includes(e)) : [...new Set([...p.fileTypes,...exts])]}; });

  const tabs = [
    { id:"dashboard", label:"Dashboard", icon:"⬡" },
    { id:"webdav",    label:"WebDAV",    icon:"☁" },
    { id:"shares",    label:"SMB Shares",icon:"🖧" },
    { id:"jobs",      label:"Sync Jobs", icon:"⇄" },
    { id:"logs",      label:"Logs",      icon:"◈" },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#080b10] text-white" style={{ fontFamily:"'IBM Plex Mono','Courier New',monospace" }}>
      <div className="fixed inset-0 pointer-events-none" style={{ backgroundImage:"linear-gradient(rgba(0,212,170,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,0.025) 1px,transparent 1px)", backgroundSize:"40px 40px" }} />

      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-52 bg-[#0a0d14]/95 border-r border-white/5 backdrop-blur-xl z-40 flex flex-col">
        <div className="px-5 py-5 border-b border-white/5">
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
            <button key={t.id} onClick={()=>setTab(t.id)} className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all text-left", tab===t.id?"bg-[#00d4aa]/15 text-[#00d4aa] border border-[#00d4aa]/20":"text-white/40 hover:text-white/70 hover:bg-white/5")}>
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-white/5 flex items-center gap-2">
          <StatusDot status={sseConnected?"ok":"error"} />
          <span className="text-white/20 text-xs">{sseConnected?"live":"reconnecting"}</span>
        </div>
      </aside>

      {/* Main */}
      <main className="ml-52 min-h-screen">
        <header className="sticky top-0 z-30 bg-[#080b10]/85 backdrop-blur-xl border-b border-white/5 px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-white text-lg font-bold">{tabs.find(t=>t.id===tab)?.label}</h1>
              <p className="text-white/25 text-xs mt-0.5">WebDAV → SMB/CIFS Sync</p>
            </div>
            <div className="flex gap-2">
              {tab==="webdav" && <Btn onClick={()=>setWebdavModal(true)} size="sm">Configure</Btn>}
              {tab==="shares" && <Btn onClick={()=>{setEditSmbId(null);setSmbForm({name:"",host:"",share:"",username:"",password:"",domain:"WORKGROUP"});setSmbModal(true);}} size="sm">+ Add Share</Btn>}
              {tab==="jobs" && <Btn onClick={()=>{setEditJobId(null);setJobForm({name:"",smbShareId:"",webdavPath:"/",smbDestPath:"",fileTypes:[],recursive:true,overwrite:false});setJobModal(true);}} size="sm" disabled={!config?.smbShares?.length}>+ New Job</Btn>}
              {tab==="logs" && <Btn onClick={async()=>{await fetch(`${API}/logs`,{method:"DELETE"});setLogs([]);}} variant="danger" size="sm">Clear</Btn>}
            </div>
          </div>
        </header>

        <div className="px-8 py-6">

          {/* ── DASHBOARD ── */}
          {tab==="dashboard" && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label:"SMB Shares", value:config?.smbShares?.length||0, icon:"🖧" },
                  { label:"Sync Jobs",  value:config?.syncJobs?.length||0,  icon:"⇄" },
                  { label:"Running",    value:config?.syncJobs?.filter(j=>j.status==="running").length||0, icon:"▶" },
                ].map(s=>(
                  <div key={s.label} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-white/35 text-xs uppercase tracking-widest">{s.label}</span>
                      <span className="text-xl">{s.icon}</span>
                    </div>
                    <div className="text-4xl font-bold text-white">{s.value}</div>
                  </div>
                ))}
              </div>

              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-3">WebDAV Source</h3>
                <div className="flex items-center gap-3">
                  <StatusDot status={config?.webdav?.username?"ok":"idle"} />
                  <span className="text-white/70 text-sm">{config?.webdav?.url||"Not configured"}</span>
                  {config?.webdav?.username && <Badge color="green">{config.webdav.username}</Badge>}
                </div>
              </div>

              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-4">SMB Shares</h3>
                {!config?.smbShares?.length ? <p className="text-white/25 text-sm">No shares configured.</p> : (
                  <div className="space-y-2">
                    {config.smbShares.map(s=>(
                      <div key={s.id} className="flex items-center gap-3 bg-white/3 rounded-xl px-4 py-2.5">
                        <StatusDot status={s.lastStatus||"unknown"} />
                        <div className="flex-1 min-w-0">
                          <span className="text-white/80 text-sm">{s.name}</span>
                          <span className="text-white/30 text-xs ml-2">\\{s.host}\{s.share}</span>
                        </div>
                        {s.lastTestedAt && <span className="text-white/20 text-xs">{formatDate(s.lastTestedAt)}</span>}
                        <Badge color={s.lastStatus==='ok'?'green':s.lastStatus==='error'?'red':'slate'}>{s.lastStatus||'untested'}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-4">Jobs</h3>
                {!config?.syncJobs?.length ? <p className="text-white/25 text-sm">No jobs configured.</p> : (
                  <div className="space-y-2">
                    {config.syncJobs.map(job=>{
                      const share = config.smbShares?.find(s=>s.id===job.smbShareId);
                      return (
                        <div key={job.id} className="flex items-center justify-between bg-white/3 rounded-xl px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <StatusDot status={job.status} />
                            <div>
                              <div className="text-white/80 text-sm">{job.name}</div>
                              <div className="text-white/25 text-xs">{job.webdavPath} → {share?.name||"?"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {job.filesCopied>0 && <Badge color="green">{job.filesCopied} files</Badge>}
                            <Btn onClick={()=>handleRunJob(job.id)} variant="secondary" size="sm" disabled={job.status==="running"}>{job.status==="running"?"Running…":"▶ Run"}</Btn>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-3">Live Activity</h3>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {!liveLogs.length && <p className="text-white/20 text-xs">No recent activity.</p>}
                  {liveLogs.slice(0,20).map((l,i)=>(
                    <div key={i} className="flex gap-2 text-xs py-0.5">
                      <span className="text-white/20 shrink-0">{new Date(l.timestamp).toLocaleTimeString()}</span>
                      <span className={cn(l.level==="error"?"text-red-400":l.level==="warn"?"text-yellow-400":"text-white/45")}>{l.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── WEBDAV ── */}
          {tab==="webdav" && (
            <div className="space-y-4">
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusDot status={testStatus.webdav==="ok"?"ok":config?.webdav?.username?"ok":"idle"} />
                  <div>
                    <div className="text-white/80 font-medium text-sm">{config?.webdav?.url||"Not configured"}</div>
                    <div className="text-white/35 text-xs">{config?.webdav?.username?`Logged in as ${config.webdav.username}`:"No credentials"}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Btn onClick={()=>setWebdavModal(true)} size="sm">Configure</Btn>
                  {config?.webdav?.username && <Btn variant="secondary" size="sm" onClick={()=>loadDavTab('/')}>↺ Refresh</Btn>}
                </div>
              </div>

              {config?.webdav?.username && (
                <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden" style={{height:'calc(100vh - 260px)'}}>
                  <div className="px-5 py-3 border-b border-white/8 text-xs text-white/40 uppercase tracking-widest">File Browser</div>
                  <div className="p-4 h-full pb-16">
                    <FileBrowser
                      items={davTabItems}
                      loading={davTabLoading}
                      error={davTabError}
                      currentPath={davTabPath}
                      onNavigate={loadDavTab}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── SMB SHARES ── */}
          {tab==="shares" && (
            <div className="space-y-3">
              {!config?.smbShares?.length && (
                <div className="bg-white/3 border border-white/8 rounded-2xl p-10 text-center">
                  <div className="text-white/15 text-5xl mb-3">🖧</div>
                  <p className="text-white/35 text-sm">No SMB shares yet.</p>
                </div>
              )}
              {config?.smbShares?.map(share=>(
                <div key={share.id} className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
                  {/* Share header row */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-500/20 flex items-center justify-center text-blue-400 text-sm shrink-0">🖧</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white font-medium text-sm flex items-center gap-2">
                        {share.name}
                        <StatusDot status={share.lastStatus||"unknown"} />
                        {share.lastStatus && <Badge color={share.lastStatus==='ok'?'green':share.lastStatus==='error'?'red':'slate'}>{share.lastStatus==='ok'?'connected':share.lastStatus==='error'?'failed':'untested'}</Badge>}
                      </div>
                      <div className="text-white/35 text-xs mt-0.5">{share.username}@\\{share.host}\{share.share} · {share.domain||'WORKGROUP'}</div>
                      {share.lastStatusMsg && share.lastStatus==='error' && (
                        <div className="text-red-400/70 text-xs mt-0.5 truncate">{share.lastStatusMsg}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {testStatus[share.id]==='testing' && <span className="text-white/30 text-xs animate-pulse">testing…</span>}
                      <Btn variant="secondary" size="sm" onClick={()=>handleTestSmb({...share, id:share.id})}>Test</Btn>
                      <Btn variant="secondary" size="sm" onClick={()=>openSharesBrowse(share.id)}>
                        {sharesBrowseId===share.id?"Hide":"Browse"}
                      </Btn>
                      <Btn variant="secondary" size="sm" onClick={()=>{ setEditSmbId(share.id); setSmbForm({...share}); setSmbModal(true); }}>Edit</Btn>
                      <Btn variant="danger" size="sm" onClick={()=>handleDeleteSmb(share.id)}>✕</Btn>
                    </div>
                  </div>

                  {/* Inline file browser */}
                  {sharesBrowseId===share.id && (
                    <div className="border-t border-white/8 px-5 py-4 bg-black/20" style={{height:'380px'}}>
                      <div className="h-full">
                        <FileBrowser
                          items={sharesBrowseItems}
                          loading={sharesBrowseLoading}
                          error={sharesBrowseError}
                          currentPath={sharesBrowsePath}
                          onNavigate={(p)=>loadSharesBrowse(share.id, p)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── JOBS ── */}
          {tab==="jobs" && (
            <div className="space-y-3">
              {!config?.smbShares?.length && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl px-4 py-3 text-yellow-400 text-sm">⚠ Add an SMB share first.</div>
              )}
              {!config?.syncJobs?.length && (
                <div className="bg-white/3 border border-white/8 rounded-2xl p-10 text-center">
                  <div className="text-white/15 text-5xl mb-3">⇄</div>
                  <p className="text-white/35 text-sm">No sync jobs yet.</p>
                </div>
              )}
              {config?.syncJobs?.map(job=>{
                const share = config.smbShares?.find(s=>s.id===job.smbShareId);
                return (
                  <div key={job.id} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <StatusDot status={job.status} />
                        <div className="min-w-0 flex-1">
                          <div className="text-white font-medium text-sm">{job.name}</div>
                          <div className="text-white/35 text-xs mt-0.5 truncate">{job.webdavPath} → {share?.name||"Unknown"} / {job.smbDestPath||"(root)"}</div>
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            {job.fileTypes?.length>0 ? job.fileTypes.map(e=><Badge key={e} color="blue">.{e}</Badge>) : <Badge color="slate">All files</Badge>}
                            {job.recursive && <Badge color="slate">Recursive</Badge>}
                            {job.overwrite && <Badge color="yellow">Overwrite</Badge>}
                            <Badge color={job.schedule && job.schedule!=="manual"?"teal":"slate"}>{scheduleLabel(job.schedule)}</Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {job.lastRun && <span className="text-white/20 text-xs">{formatDate(job.lastRun)}</span>}
                        {job.filesCopied>0 && <Badge color="green">{job.filesCopied} copied</Badge>}
                        <Btn onClick={()=>handleRunJob(job.id)} size="sm" disabled={job.status==="running"}>{job.status==="running"?"Running…":"▶ Run"}</Btn>
                        <Btn variant="secondary" size="sm" onClick={()=>{ setEditJobId(job.id); setJobForm({name:job.name,smbShareId:job.smbShareId,webdavPath:job.webdavPath,smbDestPath:job.smbDestPath,fileTypes:job.fileTypes||[],recursive:job.recursive??true,overwrite:job.overwrite??false}); setJobModal(true); }}>Edit</Btn>
                        <Btn variant="danger" size="sm" onClick={()=>handleDeleteJob(job.id)}>✕</Btn>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── LOGS ── */}
          {tab==="logs" && (
            <div className="bg-[#060810] border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                <span className="text-white/35 text-xs uppercase tracking-widest">System Logs</span>
                <span className="text-white/20 text-xs">{logs.length} entries</span>
              </div>
              <div className="max-h-[65vh] overflow-y-auto p-4 space-y-0">
                {!logs.length && <p className="text-white/20 text-xs p-2">No logs yet.</p>}
                {logs.map((l,i)=>(
                  <div key={i} className="flex gap-3 py-1 border-b border-white/3 text-xs">
                    <span className="text-white/20 shrink-0 w-36">{new Date(l.timestamp).toLocaleString()}</span>
                    <span className={cn("shrink-0 w-10 font-bold uppercase", l.level==="error"?"text-red-400":l.level==="warn"?"text-yellow-400":l.level==="debug"?"text-white/20":"text-[#00d4aa]/60")}>{l.level}</span>
                    <span className={cn("break-all", l.level==="error"?"text-red-300":"text-white/45")}>{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ── WEBDAV MODAL ── */}
      <Modal open={webdavModal} onClose={()=>setWebdavModal(false)} title="WebDAV Configuration">
        <div className="space-y-4">
          <Input label="Server URL" value={webdavForm.url} onChange={v=>setWebdavForm(p=>({...p,url:v}))} placeholder="https://webdav.torbox.app" />
          <Input label="Username" value={webdavForm.username} onChange={v=>setWebdavForm(p=>({...p,username:v}))} />
          <Input label="Password" type="password" value={webdavForm.password} onChange={v=>setWebdavForm(p=>({...p,password:v}))} />
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSaveWebdav}>Save</Btn>
            <Btn variant="secondary" onClick={handleTestWebdav}>{testStatus.webdav==="testing"?"Testing…":"Test Connection"}</Btn>
          </div>
        </div>
      </Modal>

      {/* ── SMB MODAL ── */}
      <Modal open={smbModal} onClose={()=>{setSmbModal(false);setEditSmbId(null);}} title={editSmbId?"Edit SMB Share":"Add SMB Share"}>
        <div className="space-y-4">
          <Input label="Display Name" value={smbForm.name} onChange={v=>setSmbForm(p=>({...p,name:v}))} placeholder="My NAS" />
          <Input label="Host / IP" value={smbForm.host} onChange={v=>setSmbForm(p=>({...p,host:v}))} placeholder="192.168.1.100" />
          <Input label="Share Name" value={smbForm.share} onChange={v=>setSmbForm(p=>({...p,share:v}))} placeholder="media" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Username" value={smbForm.username} onChange={v=>setSmbForm(p=>({...p,username:v}))} />
            <Input label="Password" type="password" value={smbForm.password} onChange={v=>setSmbForm(p=>({...p,password:v}))} />
          </div>
          <Input label="Domain" value={smbForm.domain} onChange={v=>setSmbForm(p=>({...p,domain:v}))} placeholder="WORKGROUP" />
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSmbSubmit}>{editSmbId?"Save Changes":"Add Share"}</Btn>
            <Btn variant="secondary" onClick={()=>handleTestSmb(smbForm)}>{testStatus["new"]==="testing"?"Testing…":"Test Connection"}</Btn>
          </div>
        </div>
      </Modal>

      {/* ── JOB MODAL ── */}
      <Modal open={jobModal} onClose={()=>setJobModal(false)} title={editJobId?"Edit Sync Job":"New Sync Job"} wide>
        <div className="space-y-5">
          <Input label="Job Name" value={jobForm.name} onChange={v=>setJobForm(p=>({...p,name:v}))} placeholder="Copy Movies" />

          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-1.5">SMB Destination Share</label>
            <select value={jobForm.smbShareId} onChange={e=>setJobForm(p=>({...p,smbShareId:e.target.value}))}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#00d4aa]/60">
              <option value="">Select a share…</option>
              {config?.smbShares?.map(s=><option key={s.id} value={s.id}>{s.name} (\\{s.host}\{s.share})</option>)}
            </select>
          </div>

          {/* Two-column path pickers */}
          <div className="grid grid-cols-2 gap-4">
            {/* WebDAV source */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40 uppercase tracking-widest font-medium">WebDAV Source Path</label>
                <Btn variant="ghost" size="sm" onClick={()=>openDavBrowser(p=>{ setJobForm(prev=>({...prev,webdavPath:p})); setDavBrowserOpen(false); })}>Browse ↗</Btn>
              </div>
              <input value={jobForm.webdavPath} onChange={e=>setJobForm(p=>({...p,webdavPath:e.target.value}))} placeholder="/"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60" />
            </div>
            {/* SMB dest */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40 uppercase tracking-widest font-medium">SMB Destination Path</label>
                {jobForm.smbShareId && (
                  <Btn variant="ghost" size="sm" onClick={()=>openSmbBrowser(jobForm.smbShareId, p=>{ setJobForm(prev=>({...prev,smbDestPath:p.startsWith('/')?p.slice(1):p})); setSmbBrowserOpen(false); })}>Browse ↗</Btn>
                )}
              </div>
              <input value={jobForm.smbDestPath} onChange={e=>setJobForm(p=>({...p,smbDestPath:e.target.value}))} placeholder="(share root)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60" />
            </div>
          </div>

          {/* File types */}
          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-2">File Type Filter</label>
            <div className="space-y-2">
              {Object.entries(FILE_TYPE_PRESETS).map(([preset,exts])=>(
                <div key={preset}>
                  <button onClick={()=>togglePreset(exts)} className={cn("text-xs px-2 py-1 rounded font-medium border transition-all mb-1.5", exts.every(e=>jobForm.fileTypes.includes(e))?"bg-[#00d4aa]/20 border-[#00d4aa]/40 text-[#00d4aa]":"bg-white/5 border-white/10 text-white/40 hover:text-white/60")}>{preset}</button>
                  <div className="flex flex-wrap gap-1">
                    {exts.map(ext=>(
                      <button key={ext} onClick={()=>toggleFileType(ext)} className={cn("text-xs px-2 py-0.5 rounded border transition-all", jobForm.fileTypes.includes(ext)?"bg-[#00d4aa]/15 border-[#00d4aa]/30 text-[#00d4aa]":"bg-white/3 border-white/8 text-white/30 hover:text-white/60")}>.{ext}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input value={customExt} onChange={e=>setCustomExt(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'&&customExt.trim()){ const ext=customExt.trim().toLowerCase().replace(/^\./,''); setJobForm(p=>({...p,fileTypes:[...new Set([...p.fileTypes,ext])]})); setCustomExt(''); }}} placeholder="custom ext…"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60" />
              <Btn variant="secondary" size="sm" onClick={()=>{ if(customExt.trim()){ const ext=customExt.trim().toLowerCase().replace(/^\./,''); setJobForm(p=>({...p,fileTypes:[...new Set([...p.fileTypes,ext])]})); setCustomExt(''); }}}>Add</Btn>
            </div>
            {jobForm.fileTypes.length>0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {jobForm.fileTypes.map(ext=>(
                  <span key={ext} className="inline-flex items-center gap-1 bg-[#00d4aa]/10 border border-[#00d4aa]/20 text-[#00d4aa] text-xs px-2 py-0.5 rounded-full">
                    .{ext}<button onClick={()=>toggleFileType(ext)} className="opacity-60 hover:opacity-100">×</button>
                  </span>
                ))}
              </div>
            )}
            {!jobForm.fileTypes.length && <p className="text-white/20 text-xs mt-2">No filter — all file types will be copied.</p>}
          </div>

          {/* Schedule */}
          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-2">Schedule</label>
            <div className="grid grid-cols-3 gap-1.5 mb-2">
              {INTERVAL_PRESETS.filter(p => p.key !== "custom").map(p => (
                <button key={p.key} onClick={()=>{ setJobForm(prev=>({...prev, schedule: p.key})); if(p.key !== "manual") setCronInput(""); }}
                  className={cn("flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-all",
                    jobForm.schedule===p.key
                      ? "bg-[#00d4aa]/15 border-[#00d4aa]/40 text-[#00d4aa]"
                      : "bg-white/3 border-white/8 text-white/40 hover:text-white/70 hover:bg-white/6")}>
                  <span>{p.icon}</span>
                  <span className="leading-tight text-center">{p.label}</span>
                </button>
              ))}
              {/* Custom cron button */}
              <button onClick={()=>setJobForm(prev=>({...prev, schedule: cronInput || "custom"}))}
                className={cn("flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-all",
                  !INTERVAL_PRESETS.find(p=>p.key===jobForm.schedule) && jobForm.schedule !== "manual"
                    ? "bg-[#00d4aa]/15 border-[#00d4aa]/40 text-[#00d4aa]"
                    : "bg-white/3 border-white/8 text-white/40 hover:text-white/70 hover:bg-white/6")}>
                <span>⚙️</span>
                <span>Custom cron</span>
              </button>
            </div>
            {/* Custom cron input — shown when no preset matches */}
            {(!INTERVAL_PRESETS.find(p=>p.key===jobForm.schedule && p.key!=="custom") || jobForm.schedule==="custom") && (
              <div className="space-y-1">
                <div className="flex gap-2">
                  <input
                    value={cronInput}
                    onChange={e=>{ setCronInput(e.target.value); setCronValid(null); }}
                    onBlur={()=>{ if(cronInput.trim()){ validateCron(cronInput); setJobForm(p=>({...p,schedule:cronInput.trim()})); }}}
                    placeholder="e.g. 0 2 * * *  (daily at 2am)"
                    className={cn("flex-1 bg-white/5 border rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none transition-all",
                      cronValid===true?"border-emerald-500/50 focus:border-emerald-400":
                      cronValid===false?"border-red-500/50 focus:border-red-400":
                      "border-white/10 focus:border-[#00d4aa]/60")} />
                  <Btn variant="secondary" size="sm" onClick={()=>{ if(cronInput.trim()){ validateCron(cronInput); setJobForm(p=>({...p,schedule:cronInput.trim()})); }}}>Validate</Btn>
                </div>
                {cronValid===true && <p className="text-emerald-400 text-xs">✓ Valid cron expression</p>}
                {cronValid===false && <p className="text-red-400 text-xs">✗ Invalid cron expression</p>}
                <p className="text-white/20 text-xs">Format: minute hour day month weekday  ·  <a href="https://crontab.guru" target="_blank" rel="noreferrer" className="text-[#00d4aa]/50 hover:text-[#00d4aa]">crontab.guru ↗</a></p>
              </div>
            )}
          </div>

          {/* Options */}
          <div className="space-y-2">
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block">Options</label>
            {[{key:"recursive",label:"Recursive (include subdirectories)"},{key:"overwrite",label:"Overwrite existing files"}].map(opt=>(
              <label key={opt.key} className="flex items-center gap-2.5 cursor-pointer group" onClick={()=>setJobForm(p=>({...p,[opt.key]:!p[opt.key]}))}>
                <div className={cn("w-4 h-4 rounded border flex items-center justify-center transition-all", jobForm[opt.key]?"bg-[#00d4aa] border-[#00d4aa]":"bg-white/5 border-white/20 group-hover:border-white/40")}>
                  {jobForm[opt.key] && <span className="text-black text-xs font-bold">✓</span>}
                </div>
                <span className="text-white/55 text-sm">{opt.label}</span>
              </label>
            ))}
          </div>

          <div className="flex gap-2">
            <Btn onClick={handleAddJob} disabled={!jobForm.name||!jobForm.smbShareId}>{editJobId?"Save Changes":"Create Job"}</Btn>
            <Btn variant="secondary" onClick={()=>setJobModal(false)}>Cancel</Btn>
          </div>
        </div>
      </Modal>

      {/* ── DAV BROWSER MODAL ── */}
      <Modal open={davBrowserOpen} onClose={()=>setDavBrowserOpen(false)} title="Browse WebDAV" wide>
        <div style={{height:'60vh'}}>
          <FileBrowser items={davBrowserItems} loading={davBrowserLoading} error={davBrowserError} currentPath={davBrowserPath}
            onNavigate={loadDavBrowser}
            onSelect={(item)=>{ davBrowserCallback && davBrowserCallback(item.path); }}
            selectLabel="Select" />
        </div>
      </Modal>

      {/* ── SMB BROWSER MODAL ── */}
      <Modal open={smbBrowserOpen} onClose={()=>setSmbBrowserOpen(false)} title={`Browse: ${config?.smbShares?.find(s=>s.id===smbBrowserShareId)?.name||'SMB Share'}`} wide>
        <div style={{height:'60vh'}}>
          <FileBrowser items={smbBrowserItems} loading={smbBrowserLoading} error={smbBrowserError} currentPath={smbBrowserPath}
            onNavigate={(p)=>loadSmbBrowser(smbBrowserShareId, p)}
            onSelect={(item)=>{ smbBrowserCallback && smbBrowserCallback(item); }}
            selectLabel="Select" />
        </div>
      </Modal>

      {/* Toast */}
      {toast && (
        <div className={cn("fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-xl border transition-all",
          toast.type==="error"?"bg-red-900/85 border-red-500/30 text-red-200":
          toast.type==="success"?"bg-emerald-900/85 border-emerald-500/30 text-emerald-200":
          "bg-slate-800/90 border-white/10 text-white/80")}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
