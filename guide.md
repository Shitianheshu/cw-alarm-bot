# Running guide

Fresh clone does not include `node_modules`, `.env`, or MongoDB data. Those stay on your machine.

## 1. Requirements

- Node.js 20 or newer
- npm
- MongoDB 8 listening on `127.0.0.1:27017`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user id (the account that will run admin commands)

## 2. Install

From the repo root:

```bash
npm install
```

## 3. Environment

Create `.env` in the repo root. It is gitignored. The process exits immediately if any of the three required values is missing.

```env
BOT_TOKEN=123456:replace-with-your-token
ADMIN_ID=8195097816
MONGODB_URI=mongodb://127.0.0.1:27017/cw-alarm-bot

PORT=5001
ANALYSIS_CHAT_ID=8195097816
VITE_PREVIEW_TELEGRAM_ID=8195097816
ANALYSIS_ALARM_MINUTES=1,2,5,10,20,30
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Telegram bot token |
| `ADMIN_ID` | yes | Telegram user id allowed to run admin commands and the admin API |
| `MONGODB_URI` | yes | Local Mongo connection string |
| `PORT` | no | HTTP port. Default `5001` |
| `ANALYSIS_CHAT_ID` | no | Where market reports go. Falls back to `ADMIN_ID` |
| `VITE_PREVIEW_TELEGRAM_ID` | no | Telegram id the local browser preview sends to admin APIs. Use the same value as `ADMIN_ID` |
| `ANALYSIS_ALARM_MINUTES` | no | Alarm slices. Default `1,2,5,10,20,30` |
| `ANALYSIS_ALARM` | no | Set to `false` to stop the alarm from starting with the server |
| `ANALYSIS_LOOKBACK_HOURS` | no | Census window. Default `24` |
| `ANALYSIS_MAX_JOBS` | no | Census cap. Default `100000`, hard max `500000` |
| `GROUP_ID` | no | Telegram group used by the older job scraper |
| `LATEST_JOB_ID` | no | Resume cursor for the older scraper |

Leave `PROXY` empty. On the VPS, set `CW_BROWSER=true` so CrowdWorks is opened in the Chrome window where Urban VPN is on. See **Run on a VPS**.

## 4. Connect MongoDB

The app does not create a Mongo server. It connects to one that is already listening. On startup, `server/db.ts` reads `MONGODB_URI` and calls `mongoose.connect`. It retries 3 times, 2 seconds apart. Success logs `MongoDB connected`. After the third failure the process exits.

### Connection string

Put this in `.env`:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/cw-alarm-bot
```

| Part | Value | Meaning |
| --- | --- | --- |
| host | `127.0.0.1` | This PC only. The server is not exposed on the network |
| port | `27017` | Default MongoDB port |
| database | `cw-alarm-bot` | Created on the first write. No setup script is required |
| user / password | none | Local MongoDB has no auth unless you turned it on |

Collections such as `job_observations`, `jobs`, and `users` appear when the app first writes them. You do not create them by hand.

### Start the server

Use a data directory outside this repo. Files under `data/` get locked by the editor and Mongo then crashes.

PowerShell, once:

```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\cw-alarm-bot\mongo" | Out-Null
& "C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe" --dbpath "$env:LOCALAPPDATA\cw-alarm-bot\mongo" --bind_ip 127.0.0.1 --port 27017
```

Leave that window open. A successful start ends with `Waiting for connections` on port `27017`.

If the Windows service `MongoDB` is already running on `27017`, skip the manual process and use that. The URI stays the same.

### Check the connection

`mongosh` (installed with MongoDB Server):

```powershell
& "C:\Program Files\MongoDB\Server\8.0\bin\mongosh.exe" "mongodb://127.0.0.1:27017/cw-alarm-bot"
```

Then:

```javascript
db.getName()
show collections
db.job_observations.countDocuments()
```

MongoDB Compass uses the same URI: `mongodb://127.0.0.1:27017/cw-alarm-bot`. Connect, then open the `cw-alarm-bot` database.

`npm run dev` must be started only after this connection works. If Mongo is down you will see `MongoDB connection attempt 1 failed` and the process will exit.

## 5. Start the app

```bash
npm run dev
```

This one process does all of the following:

- API and admin UI on `http://127.0.0.1:5001`
- Telegram bot (long polling)
- Bid-checkpoint worker
- Market alarm, unless `ANALYSIS_ALARM=false`

Logs you want:

- `MongoDB connected`
- `Serving on port 5001`
- `analysis alarm started`
- `Bot started`

Open `http://127.0.0.1:5001`. In dev, the browser is signed in as a local superadmin using `VITE_PREVIEW_TELEGRAM_ID`. Market watch is under **Market watch** (`/admin/market`).

Production (`npm run build` then `npm start`) serves the built UI from the same port and does not allow that local preview. The UI then opens only inside Telegram.

## 6. Telegram

1. Open the bot in Telegram and send `/start`.
2. Commands below work only from the `ADMIN_ID` account.

| Command | What it does |
| --- | --- |
| `/market_scan` | Count jobs posted in the lookback window and store Tokyo timestamps |
| `/market_watch` | Poll new jobs and sample bid counts at 1, 3, 5, 10, 20, and 30 minutes |
| `/market_stop` | Stop the live watch |
| `/market_report` | Send the current summary |
| `/market_alarm` | Turn the interval alarm back on |
| `/market_alarm_stop` | Stop the interval alarm |
| `/start_scraping` | Older job-alert scraper |
| `/stop_scraping` | Stop that scraper |

The alarm starts with the server. Empty 1- and 2-minute slices stay quiet. Slices of 5 minutes and longer always send, including a zero count. Full per-job timestamps stay in Mongo and in the CSV export on the Market watch page. Telegram receives the summary only.

## 7. Run on a VPS with Urban VPN

CrowdWorks returns 403 from the VPS address as well. The Node process cannot use a Chrome extension by itself. The scan opens pages inside the Chrome profile where Urban VPN is installed, so that extension carries the request.

Install Google Chrome and the Urban VPN extension on the VPS. Turn Urban VPN on and confirm `https://crowdworks.jp/public/jobs/search?order=new` loads in that window.

Close every Chrome window, then start Chrome with a debugging port so the app can use that same window:

```bash
google-chrome --remote-debugging-port=9222
```

Turn Urban VPN on again in that window and leave it open.

`.env` on the VPS:

```env
BOT_TOKEN=123456:replace-with-your-token
ADMIN_ID=8195097816
MONGODB_URI=mongodb://127.0.0.1:27017/cw-alarm-bot
PORT=5001
ANALYSIS_CHAT_ID=8195097816
ANALYSIS_ALARM_MINUTES=1,2,5,10,20,30
NODE_ENV=production
CW_BROWSER=true
```

Leave `PROXY` unset. Then:

```bash
npm install
npm run build
NODE_ENV=production npm start
```

`NODE_ENV=production` is required. The log should include `using the open Chrome on port 9222`. Run `/market_scan` after that.

If Chrome was already open without the debugging port, the app tells you to quit it and start it with `--remote-debugging-port=9222`. A 403 after Chrome is attached means Urban VPN is off in that window.

On a VPS with no desktop, install a virtual display before starting Chrome:

```bash
sudo apt-get install -y xvfb
xvfb-run -a google-chrome --remote-debugging-port=9222
```

Telegram does not need an open inbound port. Open `5001` only if you want the web UI from outside the VPS.

## 8. What “healthy” looks like

- `http://127.0.0.1:5001/api/admin/market/status?telegramId=YOUR_ADMIN_ID` returns JSON, not a connection error.
- The bot answers `/market_report`.
- A scan that cannot read CrowdWorks posts `CW相場スキャン失敗` with HTTP 403. Chrome is attached, but Urban VPN is off in that window.

## 9. Stop

Stop `npm run dev` with Ctrl+C. Stop the manual `mongod` the same way. Data remains in the `--dbpath` folder.
