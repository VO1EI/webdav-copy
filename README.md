# WebDAV → SMB Sync

A Dockerized web application to copy files from a WebDAV server (e.g. `webdav.torbox.app`) to one or more SMB/CIFS network shares, with a full browser UI.

---

## Features

- 🌐 **WebDAV source** — connects to any WebDAV server (pre-configured for torbox.app)
- 🖧 **Multiple SMB shares** — add, edit, test and delete any number of SMB/CIFS destinations
- 🎛 **File type filtering** — select by preset category (Video, Audio, Images, etc.) or add custom extensions
- 📁 **WebDAV file browser** — browse and select source directories visually
- 🔁 **Recursive sync** — optionally traverse subdirectories
- ⚙️ **Overwrite control** — skip or overwrite existing files
- 📡 **Live updates** — real-time log streaming via Server-Sent Events
- 💾 **Persistent config** — all settings saved to a Docker volume

---

## Quick Start

### Prerequisites
- Docker & Docker Compose installed

### 1. Clone / place the project
```bash
# Place all files in a directory, e.g. webdav-sync/
cd webdav-sync
```

### 2. Build and start
```bash
docker compose up --build -d
```

### 3. Open the UI
Navigate to **http://localhost:8080** in your browser.

---

## Configuration

### WebDAV
1. Go to **WebDAV** tab → **Configure**
2. Enter your server URL, username, and password
3. Click **Test Connection** to verify
4. Click **Save**

### SMB Shares
1. Go to **SMB Shares** tab → **+ Add Share**
2. Fill in:
   - **Name** — friendly label (e.g. "Home NAS")
   - **Host / IP** — server address (e.g. `192.168.1.100`)
   - **Share Name** — the SMB share name (e.g. `media`)
   - **Username / Password** — SMB credentials
   - **Domain** — defaults to `WORKGROUP`
3. Use **Test** to verify connectivity before saving

### Sync Jobs
1. Go to **Sync Jobs** tab → **+ New Job**
2. Configure:
   - **Job Name** — descriptive label
   - **SMB Destination** — pick a configured share
   - **WebDAV Source Path** — use the **Browse** button or type a path
   - **SMB Destination Path** — subfolder on the share (leave blank for root)
   - **File Types** — click presets or individual extensions; leave empty to copy all files
   - **Recursive** — include subdirectories
   - **Overwrite** — replace files that already exist
3. Click **▶ Run** to start the job manually

---

## File Type Presets

| Category  | Extensions |
|-----------|-----------|
| Video     | mp4, mkv, avi, mov, wmv, flv, m4v, webm, ts, m2ts |
| Audio     | mp3, flac, wav, aac, ogg, m4a, opus, wma |
| Images    | jpg, jpeg, png, gif, webp, bmp, tiff, raw, heic |
| Documents | pdf, doc, docx, xls, xlsx, ppt, pptx, txt, md |
| Archives  | zip, rar, 7z, tar, gz, bz2, xz |
| Subtitles | srt, ass, ssa, sub, vtt, idx |

You can also add any custom extension.

---

## Ports

| Port | Service |
|------|---------|
| 8080 | Web UI (nginx) |
| 3001 | Backend API (internal only) |

Change the exposed port in `docker-compose.yml`:
```yaml
ports:
  - "9000:80"   # Change 8080 to any port you like
```

---

## Persistent Data

All config and logs are stored in the `app-data` Docker volume at `/data/config.json`.

To back up:
```bash
docker cp webdav-smb-backend:/data/config.json ./config-backup.json
```

To restore:
```bash
docker cp ./config-backup.json webdav-smb-backend:/data/config.json
```

---

## SMB Networking Notes

The backend container needs to reach your SMB hosts on ports **139** and **445**.

- For SMB shares on your **local LAN**, ensure Docker's bridge network can route to them. You may need to add `--add-host` or use `network_mode: host` in `docker-compose.yml`.
- For SMB over **VPN**, make sure the VPN is accessible from within the container.

To use host networking (if SMB connection fails):
```yaml
# In docker-compose.yml, under the backend service:
network_mode: host
```
*(Note: frontend proxy will need the backend URL updated to `http://localhost:3001` in nginx.conf)*

---

## Logs

- Live log stream: visible in the **Dashboard** and **Logs** tabs
- Logs are persisted in the config volume (last 500 entries kept)
- Clear logs from the **Logs** tab

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| SMB test fails | Check host/share name, credentials, and that port 445 is reachable from Docker |
| WebDAV test fails | Verify URL scheme (https/http), credentials, and network access |
| Files not copied | Check file type filter — if no types selected, all files are copied. Check the Logs tab for errors |
| UI not loading | Run `docker compose logs frontend` and `docker compose logs backend` |
