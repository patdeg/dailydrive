# Daily Drive

**Bring back Spotify's Daily Drive — your personal mix of podcasts and music, updated automatically.**

Spotify [officially killed Daily Drive](https://community.spotify.com/t5/Music-Discussion/Is-Daily-Drive-gone/td-p/7377710) on March 17, 2026. This project recreates it. It runs on any Linux machine (Raspberry Pi, Orange Pi, old laptop, cloud server) and automatically refreshes a Spotify playlist every morning with your favorite podcasts interleaved with music.

> **Important:** Spotify now requires a **Premium account** for Developer Mode apps and limits you to **5 authorized users** per app. This is fine for personal use — it's a free API, you just need Premium. See [Spotify's Feb 2026 changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) for details.

---

## What It Does

Every time it runs, this script:

1. Grabs the latest episodes from your chosen podcasts
2. Picks songs from your favorite playlists (shuffled)
3. Mixes them together (e.g., 1 podcast → 3 songs → 1 podcast → 3 songs)
4. Replaces the contents of a Spotify playlist with the fresh mix

You set it up once, then it runs on autopilot via a cron job or systemd timer.

---

## Quick Start (5 minutes)

### Step 1: Get the Code

```bash
git clone https://github.com/patdeg/dailydrive.git
cd dailydrive
```

### Step 2: Run the Installer

```bash
chmod +x install.sh
./install.sh
```

This installs Node.js (if needed) and project dependencies, and creates your `config.yaml`.

### Step 3: Create a Spotify App

You need to tell Spotify that your script is allowed to manage your playlists. This is free.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Log in with your Spotify account
3. Click **Create App**
4. Fill in:
   - **App name:** Daily Drive
   - **App description:** Custom Daily Drive playlist
   - **Redirect URI:** `http://127.0.0.1:8888/callback` (must be 127.0.0.1, NOT localhost)
   - Check the **Web API** box
5. Click **Create**
6. On the app page, click **Settings**
7. Copy your **Client ID** and **Client Secret**

### Step 4: Create Your Playlist

1. Open Spotify (app or web)
2. Create a new empty playlist — call it whatever you want (e.g., "My Daily Drive")
3. Right-click → **Share** → **Copy link to playlist**
4. The link looks like: `https://open.spotify.com/playlist/ABC123xyz`
5. The part after `/playlist/` is your **Playlist ID** (`ABC123xyz`)

### Step 5: Edit Your Config

```bash
nano config.yaml
```

Fill in:
- Your **Client ID** and **Client Secret** from Step 3
- Your **Playlist ID** from Step 4
- Your favorite podcasts (see "Finding Podcast & Playlist IDs" below)
- Your music source playlists

### Step 6: Authenticate (One Time Only)

```bash
npm run setup
```

This opens a browser window asking you to log into Spotify. After you approve, a token is saved locally. You only need to do this once.

> **Headless server (no monitor)?** Two options:
>
> **Option A (easiest):** Clone the repo on your laptop, run `npm run setup` there, then copy `.spotify-token.json` and `config.yaml` to your Pi.
>
> **Option B (SSH tunnel):** From your laptop, SSH into your Pi with port forwarding: `ssh -L 8888:127.0.0.1:8888 user@your-pi-ip`, then run `npm run setup` on the Pi. The auth URL will work in your laptop's browser because port 8888 is tunneled.

### Step 7: Build Your Playlist!

```bash
npm start
```

That's it! Check your Spotify — your playlist is now filled with a fresh mix.

---

## Finding Podcast & Playlist IDs

### Podcast / Show IDs

1. Open the podcast in Spotify
2. Click **...** → **Share** → **Copy link to show**
3. The link looks like: `https://open.spotify.com/show/6z4NLXyHPga1UmSJsPK7G1`
4. The ID is: `6z4NLXyHPga1UmSJsPK7G1`

### Playlist IDs

Same process — right-click a playlist → **Share** → **Copy link**. The ID is after `/playlist/`.

---

## The Mix Pattern

The `mix_pattern` in `config.yaml` controls how content is ordered:

- `P` = one podcast episode
- `M` = one song

| Pattern    | What You Get                                       |
| ---------- | -------------------------------------------------- |
| `PMMM`     | 1 podcast, 3 songs, 1 podcast, 3 songs...         |
| `PMMMM`    | 1 podcast, 4 songs, repeat                         |
| `PMMPMMM`  | 1 podcast, 2 songs, 1 podcast, 3 songs, repeat    |
| `PM`       | Alternating podcast and song                       |
| `MMMPMMMM` | 3 songs, 1 podcast, 4 songs, repeat               |

---

## Dry Run (Test Without Changing Anything)

```bash
npm test
```

This shows you exactly what would go into the playlist — without actually changing it.

---

## Automate It (Run Every Morning)

### Option A: Cron Job (Simplest)

```bash
crontab -e
```

Add this line to refresh at 5:00 AM every day:

```
0 5 * * * cd /home/$USER/dailydrive && /usr/bin/node index.js >> /tmp/dailydrive.log 2>&1
```

### Option B: Systemd Timer (More Robust)

```bash
# Copy the service files
sudo cp systemd/dailydrive.service /etc/systemd/system/dailydrive@.service
sudo cp systemd/dailydrive.timer /etc/systemd/system/dailydrive.timer

# Enable and start (replace YOUR_USERNAME with your Linux username)
sudo systemctl enable dailydrive@YOUR_USERNAME.timer
sudo systemctl start dailydrive@YOUR_USERNAME.timer

# Check it's running
sudo systemctl status dailydrive.timer
```

To change the schedule, edit the timer file:

```bash
sudo nano /etc/systemd/system/dailydrive.timer
```

Change `OnCalendar=*-*-* 05:00:00` to your preferred time.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| `Not authenticated!` | Run `npm run setup` |
| `config.yaml not found!` | Run `cp config.example.yaml config.yaml` and edit it |
| `Token expired` | Run `npm run setup` again (tokens auto-refresh, but can expire after months of inactivity) |
| `403 Forbidden` | Make sure the playlist is yours and your app has the right scopes |
| `404 Not Found` | Double-check your podcast/playlist IDs in config.yaml |
| Script runs but playlist is empty | Check `npm test` output — are podcasts/playlists returning results? |

---

## How It Works (Under the Hood)

This project uses the [Spotify Web API](https://developer.spotify.com/documentation/web-api) via the [`spotify-web-api-node`](https://github.com/thelinmichael/spotify-web-api-node) library.

1. **Authentication:** OAuth 2.0 Authorization Code flow. The setup script starts a tiny local web server, you log into Spotify in your browser, Spotify sends a code back to the server, which exchanges it for access + refresh tokens. Tokens are saved to `.spotify-token.json` and auto-refresh on each run.

2. **Podcast Episodes:** Calls `GET /v1/shows/{id}/episodes` for each podcast in your config to get the latest episode URIs.

3. **Music Tracks:** Calls `GET /v1/playlists/{id}/tracks` for each source playlist, collects all track URIs, shuffles them, and picks the number you specified.

4. **Mixing:** Interleaves episodes and tracks according to your mix pattern.

5. **Playlist Update:** Calls `PUT /v1/playlists/{id}/tracks` to replace the entire playlist content in one shot.

---

## Background: What Was Daily Drive?

Spotify launched **Your Daily Drive** on June 12, 2019, as a personalized playlist that mixed your favorite music with news and podcast segments. It typically contained ~25 items: about 19 songs and 5-6 podcast/news clips, with short-form news (NPR, WSJ briefings) appearing first and longer podcasts placed deeper in the mix. It updated multiple times per day.

The feature expanded globally through 2021 (France, Spain, Italy, Japan, Philippines, etc.) but began degrading in late 2025 — playlists stopped updating, search couldn't find it. It was **fully removed on March 17, 2026**.

This project brings it back — but better, because *you* control exactly what goes in it.

---

## Project Structure

```
dailydrive/
├── config.example.yaml   # Template — copy to config.yaml
├── config.yaml           # Your settings (git-ignored)
├── index.js              # Main script — builds the playlist
├── setup.js              # One-time auth helper
├── install.sh            # Quick installer
├── package.json          # Node.js dependencies
├── systemd/              # Auto-run service files
│   ├── dailydrive.service
│   └── dailydrive.timer
├── .spotify-token.json   # Auth token (git-ignored, auto-created)
├── CLAUDE.md             # Instructions for AI assistants
├── AGENTS.md             # → symlink to CLAUDE.md
└── GEMINI.md             # → symlink to CLAUDE.md
```

---

## Contributing

This project is meant to be simple. PRs welcome — especially for:

- Better music discovery (recommendations API, liked songs, etc.)
- Multiple playlist support
- Web dashboard for config
- Docker support

---

## License

MIT — do whatever you want with it.
