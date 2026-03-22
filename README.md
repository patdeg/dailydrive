# Daily Drive

**Bring back Spotify's Daily Drive — your personal mix of podcasts and music, updated automatically.**

Spotify [officially killed Daily Drive](https://community.spotify.com/t5/Music-Discussion/Is-Daily-Drive-gone/td-p/7377710) on March 17, 2026. This project recreates it. It runs on any Linux machine (Raspberry Pi, Orange Pi, old laptop, cloud server) and automatically refreshes a Spotify playlist with your favorite podcasts interleaved with music.

> **Important:** Spotify now requires a **Premium account** for Developer Mode apps and limits you to **5 authorized users** per app. This is fine for personal use — it's a free API, you just need Premium. See [Spotify's Feb 2026 changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) for details.

---

## What It Does

Every time it runs, this script:

1. Grabs the latest episodes from your chosen podcasts
2. Picks songs from your top tracks, genre search, and/or source playlists (shuffled)
3. Mixes them together (e.g., 1 podcast, 4 songs, 1 podcast, 4 songs...)
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
   - **App name:** Daily Drive (or anything you like)
   - **App description:** Personal Daily Drive playlist tool
   - **Redirect URI:** `http://127.0.0.1:8888/callback` (**must** be `127.0.0.1`, NOT `localhost`)
   - Check **Web API** and **Web Playback SDK**
5. Click **Create**
6. Go to **Settings** > **User Management** and **add your Spotify account email**
7. Copy your **Client ID** and **Client Secret**

> **Why User Management?** Since Feb 2026, Dev Mode apps must explicitly list authorized users — even the app owner. Without this, playlist writes return 403 Forbidden.

### Step 4: Create Your Playlist

1. Open Spotify (app or web)
2. Create a new empty playlist — call it whatever you want (e.g., "My Daily Drive")
3. Right-click > **Share** > **Copy link to playlist**
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
- Your music sources (top tracks, genres, and/or playlists)

### Step 6: Authenticate (One Time Only)

```bash
npm run setup
```

This opens a browser window asking you to log into Spotify. After you approve, a token is saved locally. You only need to do this once (or again if your token expires after months of inactivity).

> **Headless server (no monitor)?** SSH into your server with port forwarding:
>
> ```bash
> ssh -L 8888:127.0.0.1:8888 user@your-server-ip
> ```
>
> Then run `npm run setup` on the server. Open the auth URL in your **local** browser — port 8888 is tunneled back to the server.

### Step 7: Build Your Playlist!

```bash
npm start
```

That's it! Check your Spotify — your playlist is now filled with a fresh mix.

---

## Music Sources

You can mix and match these music sources in `config.yaml`.

When both top tracks/playlists and genres are configured, the script automatically splits songs **50/50** — half familiar favorites, half new discoveries in your genre profile. This keeps each playlist refresh feeling fresh without losing the comfort of songs you love.

### Top Tracks (Recommended)

Pulls from your most-played songs — the best signal for "songs I actually enjoy and don't skip."

```yaml
music:
  top_tracks:
    enabled: true
    time_range: "short_term"   # short_term (~4 weeks), medium_term (~6 months), long_term (all time)
    count: 30                  # fetch pool (shuffled + trimmed to total_songs)
```

### Genre Discovery

Finds fresh tracks by genre via Spotify search. Great for discovering new music that matches your taste.

```yaml
music:
  genres:
    - dance pop
    - pop rock
    - electropop
    - singer-songwriter
```

**Don't know your genres?** Run `npm run taste` to auto-detect them (see [Taste Profile](#taste-profile) below).

### Source Playlists

Pull songs from your existing Spotify playlists.

```yaml
music:
  playlists:
    - name: "Chill Vibes"
      id: "your-playlist-id"
```

---

## Finding Podcast & Playlist IDs

### Podcast / Show IDs

1. Open the podcast in Spotify
2. Click **...** > **Share** > **Copy link to show**
3. The link looks like: `https://open.spotify.com/show/6z4NLXyHPga1UmSJsPK7G1`
4. The ID is: `6z4NLXyHPga1UmSJsPK7G1`

### Playlist IDs

Same process — right-click a playlist > **Share** > **Copy link**. The ID is after `/playlist/`.

---

## Podcast Pinning

Use `position: first` to always place a podcast at the start of the playlist, before the mix pattern kicks in. Great for news briefings:

```yaml
podcasts:
  - name: "NPR News Now"
    id: "6BRSvIBNQnB68GuoXJRCnQ"
    episodes: 1
    position: first         # Always plays first
```

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

Pinned episodes (`position: first`) appear before the pattern starts.

---

## Taste Profile

Auto-detect your genre tags using an LLM. The script analyzes your Spotify top tracks and artists, sends them to an AI model via [Demeterics](https://demeterics.ai), and generates genre tags for your `config.yaml`.

```bash
npm run taste
```

### Setup

1. Get a Demeterics API key at [demeterics.ai](https://demeterics.ai)
2. Add it to `.env`:
   ```
   DEMETERICS_API_KEY=dmt_your_key_here
   ```

### Demeterics Key Modes

| Mode | How | Fee |
|------|-----|-----|
| **BYOK** (default) | Store your vendor keys (OpenAI, Google, etc.) in [Settings > Provider Keys](https://demeterics.ai) on the dashboard. Or use dual-key format: `dmt_YOUR_KEY;sk-YOUR_VENDOR_KEY` | 10% |
| **Managed Key** | Demeterics provides vendor keys — no vendor account needed. Requires whitelisted access: email sales@demeterics.com with subject "Feature Access Request" | 15% |

For BYOK with inline vendor key, set your `.env` like:
```
DEMETERICS_API_KEY=dmt_your_key;sk-your-openai-key
```

See [demeterics.ai/docs/authentication](https://demeterics.ai/docs/authentication) for details.

---

## Dry Run (Test Without Changing Anything)

```bash
npm test
```

This shows you exactly what would go into the playlist — without actually changing it.

---

## Automate It

### Option A: Cron Job (Simplest)

```bash
crontab -e
```

Add this line to refresh twice daily (4 AM and 4 PM):

```
0 4,16 * * * cd /home/$USER/dailydrive && /usr/bin/node index.js >> /tmp/dailydrive.log 2>&1
```

### Option B: Systemd Timer (More Robust)

```bash
# Copy the service files
sudo cp systemd/dailydrive.service /etc/systemd/system/dailydrive@.service
sudo cp systemd/dailydrive.timer /etc/systemd/system/dailydrive@.timer
sudo systemctl daemon-reload

# Enable and start (replace YOUR_USERNAME with your Linux username)
sudo systemctl enable dailydrive@YOUR_USERNAME.timer
sudo systemctl start dailydrive@YOUR_USERNAME.timer

# Check it's running
sudo systemctl status dailydrive@YOUR_USERNAME.timer
```

The default schedule runs at 4:00 AM and 4:00 PM. Edit the timer to change it:

```bash
sudo systemctl edit dailydrive@YOUR_USERNAME.timer
```

---

## State Caching

The script saves state to `state.json` after each run. On the next run, if podcast episodes haven't changed, it skips the update to avoid disrupting playback. Delete `state.json` to force an update:

```bash
rm state.json && npm start
```

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| `Not authenticated!` | Run `npm run setup` |
| `config.yaml not found!` | Run `cp config.example.yaml config.yaml` and edit it |
| `Token expired` | Run `npm run setup` again |
| `403 Forbidden` | Add your email in Dashboard > User Management, then re-run `npm run setup` |
| `404 Not Found` | Double-check your podcast/playlist IDs in config.yaml |
| Script runs but playlist is empty | Check `npm test` output — are podcasts/playlists returning results? |
| Playlist write fails after setup | Make sure **Web API** and **Web Playback SDK** are enabled in your Spotify app settings |

---

## How It Works (Under the Hood)

This project uses the [Spotify Web API](https://developer.spotify.com/documentation/web-api) via the [`spotify-web-api-node`](https://github.com/thelinmichael/spotify-web-api-node) library.

1. **Authentication:** OAuth 2.0 Authorization Code flow. The setup script starts a local web server on `127.0.0.1:8888`, you log into Spotify in your browser, Spotify sends a code back, which is exchanged for access + refresh tokens. Tokens are saved to `.spotify-token.json` and auto-refresh on each run.

2. **Podcast Episodes:** Calls `GET /v1/shows/{id}/episodes` for each podcast to get the latest episode URIs.

3. **Music Tracks:** Fetches from your top tracks (`GET /v1/me/top/tracks`), genre search (`GET /v1/search`), and/or source playlists (`GET /v1/playlists/{id}/tracks`). Tracks are pooled, shuffled, and trimmed.

4. **Mixing:** Pinned episodes are placed first, then remaining episodes and tracks are interleaved according to your mix pattern.

5. **Playlist Update:** Uses `PUT /v1/playlists/{id}/items` to replace the entire playlist content (migrated from the deprecated `/tracks` endpoint per Spotify's Feb 2026 API changes).

---

## Spotify API Notes (as of March 2026)

- **Dev Mode requires Premium** and limits to 5 authorized users per app
- **User Management** — you must add yourself in the Dashboard, even as app owner
- `/v1/playlists/{id}/tracks` — **replaced** by `/v1/playlists/{id}/items`
- `/v1/recommendations` — **removed** (Nov 2024 deprecated, Feb 2026 removed)
- `/artists/{id}/top-tracks` — **removed** (Feb 2026)
- Audio features (valence, energy, danceability) — **deprecated** (Nov 2024)
- Artist genre tags — **empty in Dev Mode** (not available)
- `http://localhost` redirect URIs — **no longer allowed** (must use `http://127.0.0.1`)
- Implicit grant flow — **removed** (Nov 2025)

---

## Background: What Was Daily Drive?

Spotify launched **Your Daily Drive** on June 12, 2019, as a personalized playlist that mixed your favorite music with news and podcast segments. It typically contained ~25 items: about 19 songs and 5-6 podcast/news clips, with short-form news appearing first and longer podcasts placed deeper in the mix. It updated multiple times per day.

The feature expanded globally through 2021 but began degrading in late 2025 — playlists stopped updating, search couldn't find it. It was **fully removed on March 17, 2026**.

This project brings it back — but better, because *you* control exactly what goes in it.

---

## Project Structure

```
dailydrive/
├── config.example.yaml   # Template — copy to config.yaml
├── config.yaml           # Your settings (git-ignored)
├── index.js              # Main script — builds the playlist
├── setup.js              # One-time auth helper
├── taste-profile.js      # LLM-powered genre detection
├── install.sh            # Quick installer
├── .env                  # API keys (git-ignored)
├── package.json          # Node.js dependencies
├── .gitignore            # Protects secrets from being committed
├── .spotify-token.json   # Auth token (git-ignored, auto-created)
├── state.json            # Run state cache (git-ignored, auto-created)
├── systemd/              # Auto-run service files
│   ├── dailydrive.service
│   └── dailydrive.timer
├── CLAUDE.md             # Instructions for AI coding assistants
├── AGENTS.md             # → symlink to CLAUDE.md
└── GEMINI.md             # → symlink to CLAUDE.md
```

---

## Contributing

This project is meant to be simple. PRs welcome — especially for:

- Additional music sources (liked songs, recently played, etc.)
- Multiple playlist support
- Web dashboard for config
- Docker support

---

## License

MIT — do whatever you want with it.
