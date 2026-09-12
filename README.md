<p align="center">
  <img src="https://raw.githubusercontent.com/patdeg/dailydrive/main/img/dailydrive.jpg" alt="My Daily Drive" width="300">
</p>

# Daily Drive

**Bring back Spotify's Daily Drive — your personal mix of podcasts and music, updated automatically.**

Spotify [killed Daily Drive](https://community.spotify.com/t5/Music-Discussion/Is-Daily-Drive-gone/td-p/7377710) on March 17, 2026. This project brings it back. It runs on any Linux machine and automatically refreshes a Spotify playlist with your podcasts interleaved with music.

[**Listen to a live example**](https://open.spotify.com/playlist/34nCFkIuIkiFF4W5dJKiTi) — updated twice daily with NPR News, The Journal, Freakonomics, and a mix of top tracks and genre discovery.

> **You need Spotify Premium.** Since Feb 2026, Spotify requires Premium for Developer apps. It's free to use the API — you just need a Premium account.

---

## Setup Guide

### Step 1: Create a Spotify Developer App

This tells Spotify your script is allowed to manage your playlists. It's free and takes 2 minutes.

1. Go to **[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)** and log in with your Spotify account
2. Click **"Create App"**
3. Fill in the form:
   - **App name:** `Daily Drive` (or anything)
   - **App description:** `Personal playlist tool` (or anything)
   - **Redirect URI:** type in exactly: `http://127.0.0.1:8888/callback` then click **Add**
   - Check both **Web API** and **Web Playback SDK**
4. Click **"Save"**

You're now on your app's dashboard page.

#### Finding your Client ID and Client Secret

5. On your app's page, click **"Settings"** (top right)
6. You'll see your **Client ID** right there — copy it somewhere
7. Click **"View client secret"** to reveal your **Client Secret** — copy that too

#### Adding yourself as an authorized user

8. Still in Settings, scroll down to **"User Management"**
9. Type in the **email address** tied to your Spotify account and click **Add**

> **Why?** Since Feb 2026, even the app owner must be explicitly added. Without this, you'll get a 403 error when the script tries to update your playlist.

---

### Step 2: Create an empty playlist in Spotify

1. Open Spotify (the app or [open.spotify.com](https://open.spotify.com))
2. Create a new playlist — name it whatever you like (e.g., "My Daily Drive")
3. Right-click the playlist → **Share** → **Copy link to playlist**
4. You'll get a link like: `https://open.spotify.com/playlist/34nCFkIuIkiFF4W5dJKiTi`
5. The part after `/playlist/` is your **Playlist ID** — copy it

---

### Step 3: Find your podcast IDs

For each podcast you want to include:

1. Open the podcast/show in Spotify
2. Click **⋯** → **Share** → **Copy link to show**
3. You'll get a link like: `https://open.spotify.com/show/6z4NLXyHPga1UmSJsPK7G1`
4. The part after `/show/` is the **Show ID**

Some popular ones to get you started:

| Podcast | Show ID |
|---------|---------|
| NPR News Now | `6BRSvIBNQnB68GuoXJRCnQ` |
| The Daily (NYT) | `3IM0lmZxpFAY7CwMuv9H4g` |
| Freakonomics Radio | `6z4NLXyHPga1UmSJsPK7G1` |
| Up First (NPR) | `2mTUnDkuKUkhiueKcVWoP0` |
| The Journal (WSJ) | `0KxdEdeY2Wb3zr28dMlQva` |

---

### Step 4: Install and configure

```bash
# Get the code
git clone https://github.com/patdeg/dailydrive.git
cd dailydrive

# Run the installer (installs Node.js if needed + dependencies)
chmod +x install.sh
./install.sh
```

Now edit your config file:

```bash
nano config.yaml
```

Paste in your **Client ID**, **Client Secret**, **Playlist ID**, and your **podcast Show IDs** from the steps above. The file has comments explaining each field. Save and exit (`Ctrl+X`, then `Y`, then `Enter`).

---

### Step 5: Log in to Spotify (one time only)

```bash
npm run setup
```

This prints a URL. Open it in your browser, log into Spotify, and click **Agree**. The script saves your login token locally — you only do this once.

> **On a headless server (SSH, no monitor)?** Connect with port forwarding first:
> ```bash
> ssh -L 8888:127.0.0.1:8888 user@your-server
> ```
> Then run `npm run setup` on the server, and open the URL in your **local** browser.

---

### Step 6: Build your playlist!

```bash
npm start
```

Open Spotify — your playlist is now filled with a fresh mix of podcasts and music!

---

## Personalizing Your Music Mix

This is where you make it yours. Edit `config.yaml` to control what music goes in.

### Your Top Tracks (on by default)

Pulls from your most-played songs — the best signal for "songs I actually like."

```yaml
music:
  top_tracks:
    enabled: true
    time_range: "short_term"   # "short_term" (~4 weeks), "medium_term" (~6 months), "long_term" (all time)
    count: 30
```

### Add genre discovery (new music you'll like)

Add genres to discover fresh tracks that match your taste:

```yaml
music:
  genres:
    - pop
    - indie pop
    - dance pop
    - singer-songwriter
```

**Don't know your genres?** Run `npm run taste:google` to auto-detect them using AI for free (requires a [Google Gemini](https://aistudio.google.com/apikey) API key in `.env` — see [Taste Profile](#taste-profile) below). Or use `npm run taste` for the [Demeterics](https://demeterics.ai) version.

When both top tracks and genres are enabled, songs are split **50/50** — half familiar favorites, half new discoveries.

### Pull from existing playlists

```yaml
music:
  playlists:
    - name: "My Chill Playlist"
      id: "your-playlist-id-here"
```

### Control the mix pattern

The `mix_pattern` controls how podcasts (P) and music (M) alternate:

| Pattern | What it sounds like |
|---------|-------------------|
| `PMMMM` | 1 podcast, 4 songs, repeat (default) |
| `PMMM` | 1 podcast, 3 songs, repeat |
| `PM` | alternating podcast and song |
| `MMMPMMMM` | music-heavy: 3 songs, 1 podcast, 4 songs |

### Pin a podcast to always play first

Great for news briefings:

```yaml
podcasts:
  - name: "NPR News Now"
    id: "6BRSvIBNQnB68GuoXJRCnQ"
    episodes: 1
    position: first    # Always plays first, before the pattern
```

### Choose which podcast episodes to select

Each podcast can use one of three selection modes:

| Mode | Behavior |
|------|----------|
| `newest` | Selects the latest episode(s), whether played or not |
| `newest_unplayed` | Selects the most recent unplayed episode(s), falling back to the latest episode(s) if everything scanned is played |
| `oldest_unplayed` | Selects the oldest unplayed episode(s) found in the scan |

```yaml
podcasts:
  - name: "Freakonomics Radio"
    id: "6z4NLXyHPga1UmSJsPK7G1"
    episodes: 1
    mode: "newest_unplayed"
    scan_limit: 50
```

`scan_limit` is the maximum number of episodes to inspect for the unplayed modes. Spotify returns episodes newest first in batches of up to 50. `newest_unplayed` stops as soon as it has enough unplayed episodes, reducing API requests when a recent episode is available. `oldest_unplayed` may scan additional batches because it must search farther back for the oldest match.

### Use the web GUI

Start the local GUI with:

```bash
npm run gui
```

Then open `http://127.0.0.1:3000`. On desktop, the interface separates the playlist, music settings, and podcast settings into three panels. It also includes:

- **Dry run** — builds and prints a playlist preview without changing Spotify
- **Refresh with Gemini** — regenerates genre suggestions using `GEMINI_API_KEY` and saves them to `config.yaml`
- **Node log** — shows recent server and playlist-build output below Music settings

The GUI is intended for local or trusted LAN use. Do not expose it directly to the public internet because it has no login.

---

## Run It Automatically

Set up a cron job so your playlist refreshes on its own:

```bash
crontab -e
```

Add this line (refreshes at 4 AM and 4 PM daily):

```
0 4,16 * * * cd /home/$USER/dailydrive && /usr/bin/node index.js >> /tmp/dailydrive.log 2>&1
```

That's it — your Daily Drive is back on autopilot.

---

## Commands Reference

| Command | What it does |
|---------|-------------|
| `npm run setup` | Log in to Spotify (one time, or if token expires) |
| `npm start` | Build/refresh the playlist now |
| `npm test` | Dry run — shows what would happen without changing anything |
| `npm run gui` | Start the local web GUI on port 3000 |
| `npm run taste` | Auto-detect your music genres using AI (Demeterics) |
| `npm run taste:google` | Auto-detect your music genres using AI (Google Gemini — free) |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Not authenticated!` | Run `npm run setup` |
| `config.yaml not found!` | Run `cp config.example.yaml config.yaml` and edit it |
| `Token expired` | Run `npm run setup` again |
| `403 Forbidden` | Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → your app → Settings → User Management → add your Spotify email. Then re-run `npm run setup` |
| `404 Not Found` | Double-check your podcast/playlist IDs in config.yaml |
| Playlist is empty after running | Run `npm test` to see if podcasts/playlists are returning results |

---

## Taste Profile

Auto-detect your genre tags using AI. The script analyzes your Spotify listening history and suggests genre tags for your config.

### Option A: Google Gemini (free — recommended)

Uses the Google Gemini API free tier. No credit card required.

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
2. Sign in with your Google account
3. Click **"Create API key"** and select or create a Google Cloud project
4. Copy the key (starts with `AIza...`)
5. Create a `.env` file in the dailydrive folder (or add to your existing one):
   ```
   GEMINI_API_KEY=AIza...your_key_here
   ```
6. Run:
   ```bash
   npm run taste:google
   ```

Free tier limits: 15 requests/minute, 1M tokens/day — more than enough for this.

### Option B: Demeterics

Uses the [Demeterics](https://demeterics.ai) API — an LLM observability platform that acts as a proxy to 50+ providers (OpenAI, Anthropic, Google, Groq, etc.). Beyond routing, Demeterics tracks cost, latency, and errors across every call with 50+ fields per request — useful if you're building AI into multiple projects and want one dashboard to monitor spending and performance. Integration is just a URL change (OpenAI-compatible), and prompt-level tags let you slice data by app, workflow, or customer. See [demeterics.ai/observability](https://demeterics.ai/observability) for details.

1. Get an API key at [demeterics.ai](https://demeterics.ai)
2. Add to `.env`:
   ```
   DEMETERICS_API_KEY=dmt_your_key_here
   ```
3. Run:
   ```bash
   npm run taste
   ```

| Mode | How | Fee |
|------|-----|-----|
| **BYOK** (default) | Store your vendor keys (OpenAI, Google, etc.) in [Settings > Provider Keys](https://demeterics.ai). Or use dual-key format: `dmt_YOUR_KEY;sk-YOUR_VENDOR_KEY` | 10% |
| **Managed Key** | Demeterics provides vendor keys. Email sales@demeterics.com with subject "Feature Access Request" | 15% |

---

## How It Works

1. **Auth:** OAuth 2.0 — `setup.js` runs a local server, you log in via browser, tokens are saved and auto-refresh
2. **Podcasts:** Fetches latest or unplayed episodes from each show via Spotify API, stopping early for `newest_unplayed` when enough candidates are found
3. **Music:** Pulls from your top tracks, genre search, and/or playlists — pools, shuffles, and trims
4. **Mix:** Pins episodes marked `position: first`, then interleaves the rest using your mix pattern
5. **Update:** Replaces the playlist contents via the Spotify API

The script caches state in `state.json` — if nothing changed since last run, it skips the update. Delete `state.json` to force a refresh.

---

## Background: What Was Daily Drive?

Spotify launched **Your Daily Drive** on June 12, 2019 — a personalized playlist mixing music with news and podcast clips. It typically had ~25 items (19 songs + 5-6 podcast segments), updated multiple times daily. The feature was fully removed on March 17, 2026.

This project brings it back — but better, because *you* control exactly what goes in it.

---

## Contributing

PRs welcome — especially for:
- Additional music sources (liked songs, recently played, etc.)
- Multiple playlist support
- Web dashboard
- Docker support

## License

MIT — do whatever you want with it.
