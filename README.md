# WebDAV → SMB Sync

Copy files from a WebDAV server (e.g. `webdav.torbox.app`) to one or more SMB/CIFS
shares, with a web UI for browsing both sides and managing sync jobs.

## Quick Start

```bash
docker compose up --build -d
```

Open **http://localhost:8080**

## Usage

1. **WebDAV tab** → Configure → enter URL + credentials → Test → Save  
   Browse your WebDAV files directly in the tab.

2. **SMB Shares tab** → Add Share → fill in host, share name, credentials → Test  
   Click **Browse** on any share to explore its files inline.

3. **Sync Jobs tab** → New Job → pick source path (use Browse), destination share +
   folder, file type filters → Create → **▶ Run**

4. **Logs tab** → live stream of all activity

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| Port     | 8080    | Change in `docker-compose.yml` under `ports` |

Config and logs are stored in the `app-data` Docker volume at `/data/config.json`.

## SMB Networking

The backend container must be able to reach your NAS/SMB host on **ports 139 and 445**.

- **Same LAN**: works out of the box with bridge networking.
- **If SMB connection fails**: try `network_mode: host` on the backend service in
  `docker-compose.yml` (remove the `networks` section from backend too).

## File Locations

| Path | Description |
|------|-------------|
| `/data/config.json` | All settings + log history (in `app-data` volume) |

## Backup config

```bash
docker cp webdav-smb-backend:/data/config.json ./config-backup.json
```

## Restore config

```bash
docker cp ./config-backup.json webdav-smb-backend:/data/config.json
docker restart webdav-smb-backend
```
