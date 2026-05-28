import { useState, useEffect, useRef, useCallback } from "react";

const API = "/api";

const INTERVAL_PRESETS = [
  { key:"manual",  label:"Manual only",           icon:"—"  },
  { key:"15min",   label:"Every 15 minutes",       icon:"⚡" },
  { key:"30min",   label:"Every 30 minutes",       icon:"🔄" },
  { key:"1hour",   label:"Every hour",             icon:"🕐" },
  { key:"3hour",   label:"Every 3 hours",          icon:"🕒" },
  { key:"6hour",   label:"Every 6 hours",          icon:"🕕" },
  { key:"12hour",  label:"Every 12 hours",         icon:"🕛" },
  { key:"24hour",  label:"Every 24 hours (daily)", icon:"📅" },
];
function scheduleLabel(s) {
  if (!s || s === "manual") return "Manual";
  const p = INTERVAL_PRESETS.find(x => x.key === s);
  return p ? p.label : `Cron: ${s}`;
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
  if (!b||b===0) return "—";
  if (b<1024) return b+" B";
  if (b<1048576) return (b/1024).toFixed(1)+" KB";
  if (b<1073741824) return (b/1048576).toFixed(1)+" MB";
  return (b/1073741824).toFixed(2)+" GB";
}
function formatDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

function StatusDot({ status }) {
  const c = { idle:"bg-slate-500",ok:"bg-emerald-400",running:"bg-emerald-400 animate-pulse",error:"bg-red-400",unknown:"bg-slate-600" };
  return <span className={cn("inline-block w-2 h-2 rounded-full shrink-0",c[status]||"bg-slate-600")} />;
}
function Badge({ children, color="slate" }) {
  const c = {
    slate:"bg-slate-500/20 text-slate-300 border-slate-500/30",green:"bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    red:"bg-red-500/20 text-red-300 border-red-500/30",yellow:"bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    blue:"bg-blue-500/20 text-blue-300 border-blue-500/30",teal:"bg-teal-500/20 text-teal-300 border-teal-500/30",
    purple:"bg-purple-500/20 text-purple-300 border-purple-500/30",
  };
  return <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium",c[color]||c.slate)}>{children}</span>;
}
function Btn({ onClick, children, variant="primary", size="md", disabled, className }) {
  const base="inline-flex items-center gap-1.5 font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed select-none";
  const v={primary:"bg-[#00d4aa] hover:bg-[#00bfa0] text-black",secondary:"bg-white/8 hover:bg-white/12 border border-white/10 text-white",danger:"bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400",ghost:"hover:bg-white/8 text-white/50 hover:text-white",warn:"bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/30 text-yellow-400"};
  const s={sm:"px-2.5 py-1.5 text-xs",md:"px-4 py-2 text-sm",lg:"px-5 py-2.5 text-base"};
  return <button type="button" onClick={onClick} disabled={disabled} className={cn(base,v[variant]||v.secondary,s[size],className)}>{children}</button>;
}
function Input({ label, value, onChange, type="text", placeholder, className }) {
  return (
    <div className={cn("flex flex-col gap-1.5",className)}>
      {label && <label className="text-xs text-white/40 uppercase tracking-widest font-medium">{label}</label>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60 transition-all"/>
    </div>
  );
}
function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose}/>
      <div className={cn("relative bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl flex flex-col",wide?"w-full max-w-4xl max-h-[90vh]":"w-full max-w-lg max-h-[90vh]")}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8 shrink-0">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button type="button" onClick={onClose} className="text-white/30 hover:text-white text-xl leading-none transition-colors">x</button>
        </div>
        <div className="overflow-y-auto flex-1 p-6">{children}</div>
      </div>
    </div>
  );
}

function FileBrowser({ items, loading, error, currentPath, onNavigate, onSelect, selectLabel="Select" }) {
  const parts = (currentPath||'/').split('/').filter(Boolean);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-1 py-2 shrink-0 flex-wrap">
        <button type="button" onClick={()=>onNavigate('/')} className="text-[#00d4aa] hover:text-[#00bfa0] text-xs">root</button>
        {parts.map((part,i)=>(
          <span key={i} className="flex items-center gap-1">
            <span className="text-white/20 text-xs">/</span>
            <button type="button" onClick={()=>onNavigate('/'+parts.slice(0,i+1).join('/'))} className="text-[#00d4aa] hover:text-[#00bfa0] text-xs">{part}</button>
          </span>
        ))}
      </div>
      {currentPath && currentPath!=='/' && (
        <button type="button" onClick={()=>{ const p='/'+parts.slice(0,-1).join('/'); onNavigate(p||'/'); }}
          className="flex items-center gap-2 px-2 py-1.5 text-white/40 hover:text-white/70 text-sm hover:bg-white/5 rounded mx-1 mb-1">
          <span>back</span>
        </button>
      )}
      <div className="flex-1 overflow-y-auto min-h-0 border border-white/8 rounded-xl">
        {loading && <div className="flex items-center justify-center h-32 text-white/30 text-sm animate-pulse">Loading...</div>}
        {error && !loading && <div className="flex items-center justify-center h-32 text-red-400 text-sm px-4 text-center">{error}</div>}
        {!loading && !error && items.length===0 && <div className="flex items-center justify-center h-32 text-white/20 text-sm">Empty directory</div>}
        {!loading && !error && items.map((item,i)=>(
          <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0">
            <span className="text-base shrink-0">{item.type==='directory'?'[D]':'[F]'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-white/80 text-sm truncate">{item.name}</div>
              <div className="text-white/25 text-xs">{item.type==='file'?formatSize(item.size):'folder'}</div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              {item.type==='directory' && <Btn variant="ghost" size="sm" onClick={()=>onNavigate(item.path)}>Open</Btn>}
              {onSelect && <Btn variant="secondary" size="sm" onClick={()=>onSelect(item)}>{item.type==='directory'?selectLabel:'Select'}</Btn>}
            </div>
          </div>
        ))}
      </div>
      {onSelect && (
        <div className="pt-3 shrink-0">
          <Btn onClick={()=>onSelect({path:currentPath,type:'directory',name:parts[parts.length-1]||'root'})} className="w-full justify-center">
            Use: {currentPath||'/'}
          </Btn>
        </div>
      )}
    </div>
  );
}

const EMPTY_JOB = { name:"", sourceType:"webdav", webdavPath:"/", srcSmbShareId:"", srcSmbPath:"/", smbShareId:"", smbDestPath:"", fileTypes:[], recursive:true, overwrite:false, schedule:"manual" };
const EMPTY_SMB = { name:"", host:"", share:"", username:"", password:"", domain:"WORKGROUP" };

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [config, setConfig] = useState(null);
  const [logs, setLogs] = useState([]);
  const [liveLogs, setLiveLogs] = useState([]);
  const [toast, setToast] = useState(null);
  const [sseOk, setSseOk] = useState(false);

  const [smbModal, setSmbModal] = useState(false);
  const [editSmbId, setEditSmbId] = useState(null);
  const [jobModal, setJobModal] = useState(false);
  const [editJobId, setEditJobId] = useState(null);
  const [davModal, setDavModal] = useState(false);

  const [smbForm, setSmbForm] = useState(EMPTY_SMB);
  const [jobForm, setJobForm] = useState(EMPTY_JOB);
  const [davForm, setDavForm] = useState({ url:"https://webdav.torbox.app", username:"", password:"" });
  const [cronInput, setCronInput] = useState("");
  const [cronValid, setCronValid] = useState(null);
  const [customExt, setCustomExt] = useState("");
  const [testStatus, setTestStatus] = useState({});

  const [sharesBrowseId, setSharesBrowseId] = useState(null);
  const [sharesBrowsePath, setSharesBrowsePath] = useState('/');
  const [sharesBrowseItems, setSharesBrowseItems] = useState([]);
  const [sharesBrowseLoad, setSharesBrowseLoad] = useState(false);
  const [sharesBrowseErr, setSharesBrowseErr] = useState(null);

  const [davTabPath, setDavTabPath] = useState('/');
  const [davTabItems, setDavTabItems] = useState([]);
  const [davTabLoad, setDavTabLoad] = useState(false);
  const [davTabErr, setDavTabErr] = useState(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState('webdav');
  const [pickerShareId, setPickerShareId] = useState(null);
  const [pickerPath, setPickerPath] = useState('/');
  const [pickerItems, setPickerItems] = useState([]);
  const [pickerLoad, setPickerLoad] = useState(false);
  const [pickerErr, setPickerErr] = useState(null);
  const [pickerCallback, setPickerCallback] = useState(null);

  const showToast = (msg, type="info") => { setToast({msg,type}); setTimeout(()=>setToast(null),3500); };

  const fetchConfig = useCallback(async () => {
    const d = await fetch(`${API}/config`).then(r=>r.json());
    setConfig(d);
    if (d.webdav) setDavForm(d.webdav);
  }, []);

  useEffect(() => {
    fetchConfig();
    fetch(`${API}/logs`).then(r=>r.json()).then(setLogs);
    let es;
    function connect() {
      es = new EventSource(`${API}/events`);
      es.onopen = () => setSseOk(true);
      es.onerror = () => { setSseOk(false); setTimeout(connect, 3000); };
      es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type==='connected') setSseOk(true);
        if (data.type==='log') { setLiveLogs(p=>[data.data,...p].slice(0,100)); setLogs(p=>[data.data,...p].slice(0,500)); }
        if (data.type==='jobUpdate') setConfig(p=>p?{...p,syncJobs:p.syncJobs?.map(j=>j.id===data.data.id?{...j,...data.data}:j)}:p);
      };
    }
    connect();
    return () => { if(es) es.close(); };
  }, []);

  const loadDavTab = useCallback(async (p) => {
    setDavTabPath(p); setDavTabLoad(true); setDavTabErr(null);
    try { const d = await fetch(`${API}/webdav/browse?path=${encodeURIComponent(p)}`).then(r=>r.json()); if(d.success) setDavTabItems(d.contents||[]); else setDavTabErr(d.message); }
    catch(e) { setDavTabErr(e.message); }
    setDavTabLoad(false);
  },[]);

  useEffect(() => { if(tab==='webdav'&&config?.webdav?.username) loadDavTab('/'); }, [tab]);

  const loadSharesBrowse = useCallback(async (shareId, p) => {
    setSharesBrowsePath(p); setSharesBrowseLoad(true); setSharesBrowseErr(null);
    try { const d = await fetch(`${API}/smb/${shareId}/browse?path=${encodeURIComponent(p)}`).then(r=>r.json()); if(d.success) setSharesBrowseItems(d.contents||[]); else setSharesBrowseErr(d.message); }
    catch(e) { setSharesBrowseErr(e.message); }
    setSharesBrowseLoad(false);
  },[]);

  const toggleSharesBrowse = (id) => {
    if(sharesBrowseId===id){setSharesBrowseId(null);return;}
    setSharesBrowseId(id); loadSharesBrowse(id,'/');
  };

  const loadPicker = useCallback(async (mode, shareId, p) => {
    setPickerPath(p); setPickerLoad(true); setPickerErr(null);
    try {
      const url = mode==='webdav' ? `${API}/webdav/browse?path=${encodeURIComponent(p)}` : `${API}/smb/${shareId}/browse?path=${encodeURIComponent(p)}`;
      const d = await fetch(url).then(r=>r.json());
      if(d.success) setPickerItems(d.contents||[]); else setPickerErr(d.message);
    } catch(e) { setPickerErr(e.message); }
    setPickerLoad(false);
  },[]);

  const openPicker = (mode, shareId, cb) => {
    setPickerMode(mode); setPickerShareId(shareId); setPickerCallback(()=>cb);
    setPickerOpen(true); setPickerPath('/'); setPickerItems([]);
    loadPicker(mode, shareId, '/');
  };

  const handleSmbSubmit = async () => {
    const url = editSmbId ? `${API}/smb/${editSmbId}` : `${API}/smb`;
    const d = await fetch(url,{method:editSmbId?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(smbForm)}).then(r=>r.json());
    if(d.success){showToast(editSmbId?"Share updated":"Share added","success");setSmbModal(false);setEditSmbId(null);setSmbForm(EMPTY_SMB);fetchConfig();}
    else showToast(d.message,"error");
  };
  const handleDeleteSmb = async (id) => {
    if(!confirm("Delete this SMB share?")) return;
    await fetch(`${API}/smb/${id}`,{method:"DELETE"});
    showToast("Share deleted","success"); if(sharesBrowseId===id) setSharesBrowseId(null); fetchConfig();
  };
  const handleTestSmb = async (share) => {
    const key = share.id||"new";
    setTestStatus(p=>({...p,[key]:"testing"}));
    const d = await fetch(`${API}/smb/test`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(share)}).then(r=>r.json());
    setTestStatus(p=>({...p,[key]:d.success?"ok":"fail"}));
    showToast(d.message,d.success?"success":"error"); fetchConfig();
  };
  const handleTestDav = async () => {
    setTestStatus(p=>({...p,webdav:"testing"}));
    const d = await fetch(`${API}/webdav/test`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(davForm)}).then(r=>r.json());
    setTestStatus(p=>({...p,webdav:d.success?"ok":"fail"}));
    showToast(d.message,d.success?"success":"error");
  };
  const handleSaveDav = async () => {
    await fetch(`${API}/webdav`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(davForm)});
    showToast("WebDAV saved","success"); fetchConfig(); setDavModal(false);
  };
  const handleJobSubmit = async () => {
    const url = editJobId ? `${API}/jobs/${editJobId}` : `${API}/jobs`;
    const d = await fetch(url,{method:editJobId?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(jobForm)}).then(r=>r.json());
    if(d.success){showToast(editJobId?"Job updated":"Job created","success");setJobModal(false);setEditJobId(null);setJobForm(EMPTY_JOB);fetchConfig();}
    else showToast(d.message,"error");
  };
  const handleDeleteJob = async (id) => {
    if(!confirm("Delete this sync job?")) return;
    await fetch(`${API}/jobs/${id}`,{method:"DELETE"});
    showToast("Job deleted","success"); fetchConfig();
  };
  const handleRunJob  = async (id) => { const d=await fetch(`${API}/jobs/${id}/run`,{method:"POST"}).then(r=>r.json()); showToast(d.message,d.success?"info":"error"); };
  const handleStopJob = async (id) => { const d=await fetch(`${API}/jobs/${id}/stop`,{method:"POST"}).then(r=>r.json()); showToast(d.message,d.success?"warn":"error"); };
  const validateCron  = async (expr) => {
    if(!expr.trim()){setCronValid(null);return;}
    const d=await fetch(`${API}/cron/validate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expr})}).then(r=>r.json());
    setCronValid(d.valid);
  };
  const toggleExt = (ext) => setJobForm(p=>({...p,fileTypes:p.fileTypes.includes(ext)?p.fileTypes.filter(e=>e!==ext):[...p.fileTypes,ext]}));
  const togglePreset = (exts) => setJobForm(p=>{const all=exts.every(e=>p.fileTypes.includes(e));return{...p,fileTypes:all?p.fileTypes.filter(e=>!exts.includes(e)):[...new Set([...p.fileTypes,...exts])]};});

  const tabs=[{id:"dashboard",label:"Dashboard",icon:"D"},{id:"webdav",label:"WebDAV",icon:"W"},{id:"shares",label:"SMB Shares",icon:"S"},{id:"jobs",label:"Sync Jobs",icon:"J"},{id:"logs",label:"Logs",icon:"L"}];

  return (
    <div className="min-h-screen bg-[#080b10] text-white" style={{fontFamily:"'IBM Plex Mono','Courier New',monospace"}}>
      <div className="fixed inset-0 pointer-events-none" style={{backgroundImage:"linear-gradient(rgba(0,212,170,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,0.025) 1px,transparent 1px)",backgroundSize:"40px 40px"}}/>

      <aside className="fixed left-0 top-0 h-full w-52 bg-[#0a0d14]/95 border-r border-white/5 backdrop-blur-xl z-40 flex flex-col">
        <div className="px-5 py-5 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#00d4aa] flex items-center justify-center text-black font-bold text-base">Z</div>
            <div>
              <div className="text-white font-bold text-base leading-none">Zerosync</div>
              <div className="text-[#00d4aa]/60 text-xs mt-0.5">File Sync</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {tabs.map(t=>(
            <button type="button" key={t.id} onClick={()=>setTab(t.id)}
              className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all text-left",
                tab===t.id?"bg-[#00d4aa]/15 text-[#00d4aa] border border-[#00d4aa]/20":"text-white/40 hover:text-white/70 hover:bg-white/5")}>
              <span className="w-4 text-center text-xs opacity-50">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-white/5 flex items-center gap-2">
          <StatusDot status={sseOk?"ok":"error"}/>
          <span className="text-white/20 text-xs">{sseOk?"live":"reconnecting"}</span>
        </div>
      </aside>

      <main className="ml-52 min-h-screen">
        <header className="sticky top-0 z-30 bg-[#080b10]/85 backdrop-blur-xl border-b border-white/5 px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-white text-lg font-bold">{tabs.find(t=>t.id===tab)?.label}</h1>
              <p className="text-white/25 text-xs mt-0.5">Zerosync - File Sync Engine</p>
            </div>
            <div className="flex gap-2">
              {tab==="webdav" && <Btn onClick={()=>setDavModal(true)} size="sm">Configure</Btn>}
              {tab==="shares" && <Btn onClick={()=>{setEditSmbId(null);setSmbForm(EMPTY_SMB);setSmbModal(true);}} size="sm">+ Add Share</Btn>}
              {tab==="jobs"   && <Btn onClick={()=>{setEditJobId(null);setJobForm(EMPTY_JOB);setJobModal(true);}} size="sm">+ New Job</Btn>}
              {tab==="logs"   && <Btn onClick={async()=>{await fetch(`${API}/logs`,{method:"DELETE"});setLogs([]);}} variant="danger" size="sm">Clear</Btn>}
            </div>
          </div>
        </header>

        <div className="px-8 py-6">
          {/* DASHBOARD */}
          {tab==="dashboard" && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-4">
                {[{label:"SMB Shares",value:config?.smbShares?.length||0},{label:"Sync Jobs",value:config?.syncJobs?.length||0},{label:"Running",value:config?.syncJobs?.filter(j=>j.status==="running").length||0}].map(s=>(
                  <div key={s.label} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="text-white/35 text-xs uppercase tracking-widest mb-3">{s.label}</div>
                    <div className="text-4xl font-bold text-white">{s.value}</div>
                  </div>
                ))}
              </div>
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-3">WebDAV Source</h3>
                <div className="flex items-center gap-3">
                  <StatusDot status={config?.webdav?.username?"ok":"idle"}/>
                  <span className="text-white/70 text-sm">{config?.webdav?.url||"Not configured"}</span>
                  {config?.webdav?.username && <Badge color="green">{config.webdav.username}</Badge>}
                </div>
              </div>
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-4">SMB Shares</h3>
                {!config?.smbShares?.length?<p className="text-white/25 text-sm">No shares configured.</p>:(
                  <div className="space-y-2">
                    {config.smbShares.map(s=>(
                      <div key={s.id} className="flex items-center gap-3 bg-white/3 rounded-xl px-4 py-2.5">
                        <StatusDot status={s.lastStatus||"unknown"}/>
                        <span className="text-white/80 text-sm flex-1">{s.name}</span>
                        <span className="text-white/30 text-xs">\\{s.host}\{s.share}</span>
                        <Badge color={s.lastStatus==='ok'?'green':s.lastStatus==='error'?'red':'slate'}>{s.lastStatus||'untested'}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
                <h3 className="text-white/40 text-xs uppercase tracking-widest mb-4">Sync Jobs</h3>
                {!config?.syncJobs?.length?<p className="text-white/25 text-sm">No jobs configured.</p>:(
                  <div className="space-y-2">
                    {config.syncJobs.map(job=>{
                      const dest=config.smbShares?.find(s=>s.id===job.smbShareId);
                      const src=job.sourceType==='smb'?config.smbShares?.find(s=>s.id===job.srcSmbShareId):null;
                      return (
                        <div key={job.id} className="flex items-center justify-between bg-white/3 rounded-xl px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <StatusDot status={job.status}/>
                            <div>
                              <div className="text-white/80 text-sm">{job.name}</div>
                              <div className="text-white/25 text-xs">{job.sourceType==='smb'?`${src?.name||'?'}`:'WebDAV'} to {dest?.name||'?'}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {job.filesCopied>0&&<Badge color="green">{job.filesCopied} files</Badge>}
                            {job.schedule&&job.schedule!=='manual'&&<Badge color="teal">{scheduleLabel(job.schedule)}</Badge>}
                            {job.status==='running'
                              ?<Btn onClick={()=>handleStopJob(job.id)} variant="warn" size="sm">Stop</Btn>
                              :<Btn onClick={()=>handleRunJob(job.id)} variant="secondary" size="sm">Run</Btn>}
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
                  {!liveLogs.length&&<p className="text-white/20 text-xs">No recent activity.</p>}
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

          {/* WEBDAV */}
          {tab==="webdav" && (
            <div className="space-y-4">
              <div className="bg-white/3 border border-white/8 rounded-2xl p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusDot status={config?.webdav?.username?"ok":"idle"}/>
                  <div>
                    <div className="text-white/80 font-medium text-sm">{config?.webdav?.url||"Not configured"}</div>
                    <div className="text-white/35 text-xs">{config?.webdav?.username?`Signed in as ${config.webdav.username}`:"No credentials"}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Btn onClick={()=>setDavModal(true)} size="sm">Configure</Btn>
                  {config?.webdav?.username&&<Btn variant="secondary" size="sm" onClick={()=>loadDavTab('/')}>Refresh</Btn>}
                </div>
              </div>
              {config?.webdav?.username&&(
                <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden" style={{height:'calc(100vh - 260px)'}}>
                  <div className="px-5 py-3 border-b border-white/8 text-xs text-white/40 uppercase tracking-widest">File Browser</div>
                  <div className="p-4" style={{height:'calc(100% - 48px)'}}>
                    <FileBrowser items={davTabItems} loading={davTabLoad} error={davTabErr} currentPath={davTabPath} onNavigate={loadDavTab}/>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SMB SHARES */}
          {tab==="shares" && (
            <div className="space-y-3">
              {!config?.smbShares?.length&&(
                <div className="bg-white/3 border border-white/8 rounded-2xl p-10 text-center">
                  <p className="text-white/35 text-sm">No SMB shares yet.</p>
                </div>
              )}
              {config?.smbShares?.map(share=>(
                <div key={share.id} className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
                  <div className="flex items-center gap-4 px-5 py-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-white font-medium text-sm flex items-center gap-2">
                        {share.name}
                        <StatusDot status={share.lastStatus||"unknown"}/>
                        <Badge color={share.lastStatus==='ok'?'green':share.lastStatus==='error'?'red':'slate'}>
                          {share.lastStatus==='ok'?'connected':share.lastStatus==='error'?'failed':'untested'}
                        </Badge>
                      </div>
                      <div className="text-white/35 text-xs mt-0.5">{share.username}@\\{share.host}\{share.share}</div>
                      {share.lastStatusMsg&&share.lastStatus==='error'&&<div className="text-red-400/70 text-xs mt-0.5 truncate">{share.lastStatusMsg}</div>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {testStatus[share.id]==='testing'&&<span className="text-white/30 text-xs animate-pulse">testing...</span>}
                      <Btn variant="secondary" size="sm" onClick={()=>handleTestSmb({...share})}>Test</Btn>
                      <Btn variant="secondary" size="sm" onClick={()=>toggleSharesBrowse(share.id)}>{sharesBrowseId===share.id?"Hide":"Browse"}</Btn>
                      <Btn variant="secondary" size="sm" onClick={()=>{setEditSmbId(share.id);setSmbForm({...share});setSmbModal(true);}}>Edit</Btn>
                      <Btn variant="danger" size="sm" onClick={()=>handleDeleteSmb(share.id)}>Delete</Btn>
                    </div>
                  </div>
                  {sharesBrowseId===share.id&&(
                    <div className="border-t border-white/8 px-5 py-4 bg-black/20" style={{height:360}}>
                      <FileBrowser items={sharesBrowseItems} loading={sharesBrowseLoad} error={sharesBrowseErr}
                        currentPath={sharesBrowsePath} onNavigate={p=>loadSharesBrowse(share.id,p)}/>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* JOBS */}
          {tab==="jobs" && (
            <div className="space-y-3">
              {!config?.syncJobs?.length&&(
                <div className="bg-white/3 border border-white/8 rounded-2xl p-10 text-center">
                  <p className="text-white/35 text-sm">No sync jobs yet.</p>
                </div>
              )}
              {config?.syncJobs?.map(job=>{
                const dest=config.smbShares?.find(s=>s.id===job.smbShareId);
                const src=job.sourceType==='smb'?config.smbShares?.find(s=>s.id===job.srcSmbShareId):null;
                return (
                  <div key={job.id} className="bg-white/3 border border-white/8 rounded-2xl p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <StatusDot status={job.status}/>
                        <div className="min-w-0 flex-1">
                          <div className="text-white font-medium text-sm flex items-center gap-2">
                            {job.name}
                            <Badge color={job.sourceType==='smb'?'purple':'blue'}>{job.sourceType==='smb'?'SMB to SMB':'WebDAV to SMB'}</Badge>
                          </div>
                          <div className="text-white/35 text-xs mt-0.5 truncate">
                            {job.sourceType==='smb'
                              ?`${src?.name||'?'}${job.srcSmbPath||''} to ${dest?.name||'?'}${job.smbDestPath?'/'+job.smbDestPath:''}`
                              :`${job.webdavPath||'/'} to ${dest?.name||'?'}${job.smbDestPath?'/'+job.smbDestPath:''}`}
                          </div>
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            {job.fileTypes?.length?job.fileTypes.map(e=><Badge key={e} color="blue">.{e}</Badge>):<Badge color="slate">All files</Badge>}
                            {job.recursive&&<Badge color="slate">Recursive</Badge>}
                            {job.overwrite&&<Badge color="yellow">Overwrite</Badge>}
                            <Badge color={job.schedule&&job.schedule!=='manual'?'teal':'slate'}>{scheduleLabel(job.schedule)}</Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {job.lastRun&&<span className="text-white/20 text-xs">{formatDate(job.lastRun)}</span>}
                        {job.filesCopied>0&&<Badge color="green">{job.filesCopied}</Badge>}
                        {job.status==='running'
                          ?<Btn onClick={()=>handleStopJob(job.id)} variant="warn" size="sm">Stop</Btn>
                          :<Btn onClick={()=>handleRunJob(job.id)} size="sm">Run</Btn>}
                        <Btn variant="secondary" size="sm" onClick={()=>{
                          setEditJobId(job.id);
                          setJobForm({name:job.name,sourceType:job.sourceType||'webdav',webdavPath:job.webdavPath||'/',srcSmbShareId:job.srcSmbShareId||'',srcSmbPath:job.srcSmbPath||'/',smbShareId:job.smbShareId||'',smbDestPath:job.smbDestPath||'',fileTypes:job.fileTypes||[],recursive:job.recursive??true,overwrite:job.overwrite??false,schedule:job.schedule||'manual'});
                          setJobModal(true);
                        }}>Edit</Btn>
                        <Btn variant="danger" size="sm" onClick={()=>handleDeleteJob(job.id)}>Delete</Btn>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* LOGS */}
          {tab==="logs" && (
            <div className="bg-[#060810] border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                <span className="text-white/35 text-xs uppercase tracking-widest">System Logs</span>
                <span className="text-white/20 text-xs">{logs.length} entries</span>
              </div>
              <div className="max-h-[65vh] overflow-y-auto p-4">
                {!logs.length&&<p className="text-white/20 text-xs p-2">No logs yet.</p>}
                {logs.map((l,i)=>(
                  <div key={i} className="flex gap-3 py-1 border-b border-white/3 text-xs">
                    <span className="text-white/20 shrink-0 w-36">{new Date(l.timestamp).toLocaleString()}</span>
                    <span className={cn("shrink-0 w-10 font-bold uppercase",l.level==="error"?"text-red-400":l.level==="warn"?"text-yellow-400":l.level==="debug"?"text-white/20":"text-[#00d4aa]/60")}>{l.level}</span>
                    <span className={cn("break-all",l.level==="error"?"text-red-300":"text-white/45")}>{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* WEBDAV MODAL */}
      <Modal open={davModal} onClose={()=>setDavModal(false)} title="WebDAV Configuration">
        <div className="space-y-4">
          <Input label="Server URL" value={davForm.url} onChange={v=>setDavForm(p=>({...p,url:v}))} placeholder="https://webdav.torbox.app"/>
          <Input label="Username" value={davForm.username} onChange={v=>setDavForm(p=>({...p,username:v}))}/>
          <Input label="Password" type="password" value={davForm.password} onChange={v=>setDavForm(p=>({...p,password:v}))}/>
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSaveDav}>Save</Btn>
            <Btn variant="secondary" onClick={handleTestDav}>{testStatus.webdav==="testing"?"Testing...":"Test"}</Btn>
          </div>
        </div>
      </Modal>

      {/* SMB MODAL */}
      <Modal open={smbModal} onClose={()=>{setSmbModal(false);setEditSmbId(null);}} title={editSmbId?"Edit SMB Share":"Add SMB Share"}>
        <div className="space-y-4">
          <Input label="Display Name" value={smbForm.name} onChange={v=>setSmbForm(p=>({...p,name:v}))} placeholder="My NAS"/>
          <Input label="Host / IP" value={smbForm.host} onChange={v=>setSmbForm(p=>({...p,host:v}))} placeholder="192.168.1.100"/>
          <Input label="Share Name" value={smbForm.share} onChange={v=>setSmbForm(p=>({...p,share:v}))} placeholder="media"/>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Username" value={smbForm.username} onChange={v=>setSmbForm(p=>({...p,username:v}))}/>
            <Input label="Password" type="password" value={smbForm.password} onChange={v=>setSmbForm(p=>({...p,password:v}))}/>
          </div>
          <Input label="Domain" value={smbForm.domain} onChange={v=>setSmbForm(p=>({...p,domain:v}))} placeholder="WORKGROUP"/>
          <div className="flex gap-2 pt-2">
            <Btn onClick={handleSmbSubmit}>{editSmbId?"Save Changes":"Add Share"}</Btn>
            <Btn variant="secondary" onClick={()=>handleTestSmb(smbForm)}>{testStatus[editSmbId||"new"]==="testing"?"Testing...":"Test"}</Btn>
          </div>
        </div>
      </Modal>

      {/* JOB MODAL */}
      <Modal open={jobModal} onClose={()=>setJobModal(false)} title={editJobId?"Edit Sync Job":"New Sync Job"} wide>
        <div className="space-y-5">
          <Input label="Job Name" value={jobForm.name} onChange={v=>setJobForm(p=>({...p,name:v}))} placeholder="Copy Movies"/>

          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-2">Source Type</label>
            <div className="grid grid-cols-2 gap-2">
              {[{v:"webdav",label:"WebDAV",desc:"Torbox / any WebDAV server"},{v:"smb",label:"SMB Share",desc:"Another network share"}].map(opt=>(
                <button type="button" key={opt.v} onClick={()=>setJobForm(p=>({...p,sourceType:opt.v}))}
                  className={cn("flex flex-col items-start px-4 py-3 rounded-xl border text-sm transition-all text-left",
                    jobForm.sourceType===opt.v?"bg-[#00d4aa]/15 border-[#00d4aa]/40 text-[#00d4aa]":"bg-white/3 border-white/10 text-white/50 hover:bg-white/5")}>
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-xs opacity-60 mt-0.5">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {jobForm.sourceType==='webdav'?(
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40 uppercase tracking-widest font-medium">WebDAV Source Path</label>
                <Btn variant="ghost" size="sm" onClick={()=>openPicker('webdav',null,p=>{ setJobForm(prev=>({...prev,webdavPath:p})); setPickerOpen(false); })}>Browse</Btn>
              </div>
              <input value={jobForm.webdavPath} onChange={e=>setJobForm(p=>({...p,webdavPath:e.target.value}))} placeholder="/"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60"/>
            </div>
          ):(
            <div className="space-y-3">
              <div>
                <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-1.5">Source SMB Share</label>
                <select value={jobForm.srcSmbShareId} onChange={e=>setJobForm(p=>({...p,srcSmbShareId:e.target.value}))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#00d4aa]/60">
                  <option value="">Select source share...</option>
                  {config?.smbShares?.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-white/40 uppercase tracking-widest font-medium">Source Path</label>
                  {jobForm.srcSmbShareId&&<Btn variant="ghost" size="sm" onClick={()=>openPicker('smb',jobForm.srcSmbShareId,p=>{ setJobForm(prev=>({...prev,srcSmbPath:p})); setPickerOpen(false); })}>Browse</Btn>}
                </div>
                <input value={jobForm.srcSmbPath} onChange={e=>setJobForm(p=>({...p,srcSmbPath:e.target.value}))} placeholder="/"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60"/>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-1.5">Destination SMB Share</label>
              <select value={jobForm.smbShareId} onChange={e=>setJobForm(p=>({...p,smbShareId:e.target.value}))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#00d4aa]/60">
                <option value="">Select destination share...</option>
                {config?.smbShares?.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40 uppercase tracking-widest font-medium">Destination Path</label>
                {jobForm.smbShareId&&<Btn variant="ghost" size="sm" onClick={()=>openPicker('smb',jobForm.smbShareId,p=>{ setJobForm(prev=>({...prev,smbDestPath:p.startsWith('/')?p.slice(1):p})); setPickerOpen(false); })}>Browse</Btn>}
              </div>
              <input value={jobForm.smbDestPath} onChange={e=>setJobForm(p=>({...p,smbDestPath:e.target.value}))} placeholder="(share root)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60"/>
            </div>
          </div>

          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-2">File Type Filter</label>
            <div className="space-y-2">
              {Object.entries(FILE_TYPE_PRESETS).map(([preset,exts])=>(
                <div key={preset}>
                  <button type="button" onClick={()=>togglePreset(exts)}
                    className={cn("text-xs px-2 py-1 rounded font-medium border transition-all mb-1.5",
                      exts.every(e=>jobForm.fileTypes.includes(e))?"bg-[#00d4aa]/20 border-[#00d4aa]/40 text-[#00d4aa]":"bg-white/5 border-white/10 text-white/40 hover:text-white/60")}>
                    {preset}
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {exts.map(ext=>(
                      <button type="button" key={ext} onClick={()=>toggleExt(ext)}
                        className={cn("text-xs px-2 py-0.5 rounded border transition-all",
                          jobForm.fileTypes.includes(ext)?"bg-[#00d4aa]/15 border-[#00d4aa]/30 text-[#00d4aa]":"bg-white/3 border-white/8 text-white/30 hover:text-white/60")}>
                        .{ext}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input value={customExt} onChange={e=>setCustomExt(e.target.value)} placeholder="custom ext..."
                onKeyDown={e=>{ if(e.key==='Enter'&&customExt.trim()){ const x=customExt.trim().toLowerCase().replace(/^\./,''); setJobForm(p=>({...p,fileTypes:[...new Set([...p.fileTypes,x])]})); setCustomExt(''); }}}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#00d4aa]/60"/>
              <Btn variant="secondary" size="sm" onClick={()=>{ if(customExt.trim()){ const x=customExt.trim().toLowerCase().replace(/^\./,''); setJobForm(p=>({...p,fileTypes:[...new Set([...p.fileTypes,x])]})); setCustomExt(''); }}}>Add</Btn>
            </div>
            {jobForm.fileTypes.length>0&&(
              <div className="flex flex-wrap gap-1 mt-2">
                {jobForm.fileTypes.map(ext=>(
                  <span key={ext} className="inline-flex items-center gap-1 bg-[#00d4aa]/10 border border-[#00d4aa]/20 text-[#00d4aa] text-xs px-2 py-0.5 rounded-full">
                    .{ext}<button type="button" onClick={()=>toggleExt(ext)} className="opacity-60 hover:opacity-100">x</button>
                  </span>
                ))}
              </div>
            )}
            {!jobForm.fileTypes.length&&<p className="text-white/20 text-xs mt-2">No filter - all file types will be copied.</p>}
          </div>

          <div>
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block mb-2">Schedule</label>
            <div className="grid grid-cols-4 gap-1.5 mb-2">
              {INTERVAL_PRESETS.map(p=>(
                <button type="button" key={p.key} onClick={()=>{ setJobForm(prev=>({...prev,schedule:p.key})); setCronInput(''); }}
                  className={cn("flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-all",
                    jobForm.schedule===p.key?"bg-[#00d4aa]/15 border-[#00d4aa]/40 text-[#00d4aa]":"bg-white/3 border-white/8 text-white/40 hover:text-white/70")}>
                  <span>{p.icon}</span><span className="text-center leading-tight">{p.label}</span>
                </button>
              ))}
              <button type="button" onClick={()=>setJobForm(prev=>({...prev,schedule:cronInput||'custom'}))}
                className={cn("flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-all",
                  jobForm.schedule&&!INTERVAL_PRESETS.find(x=>x.key===jobForm.schedule)?"bg-[#00d4aa]/15 border-[#00d4aa]/40 text-[#00d4aa]":"bg-white/3 border-white/8 text-white/40 hover:text-white/70")}>
                <span>C</span><span>Custom cron</span>
              </button>
            </div>
            {jobForm.schedule&&!INTERVAL_PRESETS.find(x=>x.key===jobForm.schedule)&&(
              <div className="space-y-1">
                <div className="flex gap-2">
                  <input value={cronInput} onChange={e=>{ setCronInput(e.target.value); setCronValid(null); }}
                    onBlur={()=>{ if(cronInput.trim()){ validateCron(cronInput); setJobForm(p=>({...p,schedule:cronInput.trim()})); }}}
                    placeholder="e.g. 0 2 * * *  (daily at 2am)"
                    className={cn("flex-1 bg-white/5 border rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none transition-all",
                      cronValid===true?"border-emerald-500/50":cronValid===false?"border-red-500/50":"border-white/10")}/>
                  <Btn variant="secondary" size="sm" onClick={()=>{ if(cronInput.trim()){ validateCron(cronInput); setJobForm(p=>({...p,schedule:cronInput.trim()})); }}}>Validate</Btn>
                </div>
                {cronValid===true&&<p className="text-emerald-400 text-xs">Valid cron expression</p>}
                {cronValid===false&&<p className="text-red-400 text-xs">Invalid cron expression</p>}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs text-white/40 uppercase tracking-widest font-medium block">Options</label>
            {[{key:"recursive",label:"Recursive (include subdirectories)"},{key:"overwrite",label:"Overwrite existing files"}].map(opt=>(
              <label key={opt.key} className="flex items-center gap-2.5 cursor-pointer group" onClick={()=>setJobForm(p=>({...p,[opt.key]:!p[opt.key]}))}>
                <div className={cn("w-4 h-4 rounded border flex items-center justify-center transition-all",jobForm[opt.key]?"bg-[#00d4aa] border-[#00d4aa]":"bg-white/5 border-white/20 group-hover:border-white/40")}>
                  {jobForm[opt.key]&&<span className="text-black text-xs font-bold">v</span>}
                </div>
                <span className="text-white/55 text-sm">{opt.label}</span>
              </label>
            ))}
          </div>

          <div className="flex gap-2">
            <Btn onClick={handleJobSubmit} disabled={!jobForm.name||!jobForm.smbShareId}>{editJobId?"Save Changes":"Create Job"}</Btn>
            <Btn variant="secondary" onClick={()=>setJobModal(false)}>Cancel</Btn>
          </div>
        </div>
      </Modal>

      {/* PICKER MODAL */}
      <Modal open={pickerOpen} onClose={()=>setPickerOpen(false)} title={pickerMode==='webdav'?"Browse WebDAV":`Browse: ${config?.smbShares?.find(s=>s.id===pickerShareId)?.name||'SMB'}`} wide>
        <div style={{height:'60vh'}}>
          <FileBrowser items={pickerItems} loading={pickerLoad} error={pickerErr} currentPath={pickerPath}
            onNavigate={p=>{ setPickerPath(p); loadPicker(pickerMode,pickerShareId,p); }}
            onSelect={item=>{ if(pickerCallback) pickerCallback(item.path); }}
            selectLabel="Select"/>
        </div>
      </Modal>

      {toast&&(
        <div className={cn("fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-xl border",
          toast.type==="error"?"bg-red-900/85 border-red-500/30 text-red-200":
          toast.type==="success"?"bg-emerald-900/85 border-emerald-500/30 text-emerald-200":
          toast.type==="warn"?"bg-yellow-900/85 border-yellow-500/30 text-yellow-200":
          "bg-slate-800/90 border-white/10 text-white/80")}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
