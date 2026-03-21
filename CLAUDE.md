# Daily Drive — AI Assistant Guide

This file helps AI coding assistants (Claude, Gemini, Copilot, etc.) understand and work with this project.

## What This Project Does

Recreates Spotify's discontinued "Daily Drive" feature — a playlist that mixes podcast episodes and music tracks, updated automatically on a schedule. Runs on Raspberry Pi, Orange Pi, or any Linux machine.

## Tech Stack

- **Runtime:** Node.js (v18+)
- **Spotify Library:** `spotify-web-api-node` — wraps the Spotify Web API
- **Config:** YAML via `js-yaml`
- **Auth:** OAuth 2.0 Authorization Code flow with token persistence
- **Scheduling:** systemd timer or cron

## Project Structure

```
index.js              — Main script: fetches podcasts + music, mixes, updates playlist
setup.js              — One-time OAuth setup: starts local server, catches callback, saves token
config.example.yaml   — Config template with comments explaining every field
config.yaml           — User's actual config (git-ignored)
.spotify-token.json   — Saved OAuth tokens (git-ignored, auto-refreshed)
install.sh            — Quick installer for fresh Linux machines
systemd/              — Service + timer files for auto-scheduling
package.json          — Dependencies and npm scripts
```

## Key Commands

```bash
npm install           # Install dependencies
npm run setup         # One-time Spotify authentication
npm start             # Run the playlist builder
npm test              # Dry run (shows what would happen without changing the playlist)
```

## How the Code Works

### Authentication Flow (setup.js)
1. Reads Spotify credentials from `config.yaml`
2. Starts Express server on port 8888
3. Generates Spotify auth URL with required scopes
4. User approves in browser → Spotify redirects with auth code
5. Exchanges code for access + refresh tokens
6. Saves tokens to `.spotify-token.json`

### Playlist Building Flow (index.js)
1. Loads config and tokens
2. Auto-refreshes access token if expiring within 5 minutes
3. Fetches latest episodes for each podcast via `getShowEpisodes()`
4. Fetches tracks from source playlists via `getPlaylistTracks()`
5. Shuffles tracks and trims to `total_songs` count
6. Interleaves episodes and tracks using the `mix_pattern`
7. Replaces entire playlist content via `replaceTracksInPlaylist()`

### Mix Pattern Logic
Pattern string like `"PMMM"` where P = podcast, M = music. The pattern repeats cyclically. When one content type runs out, remaining items of the other type are appended.

## Spotify API Endpoints Used

- `GET /v1/shows/{id}/episodes` — latest podcast episodes
- `GET /v1/playlists/{id}/tracks` — tracks from source playlists
- `PUT /v1/playlists/{id}/tracks` — replace playlist contents
- `POST /v1/playlists/{id}/tracks` — add tracks (for batches > 100)
- `POST /api/token` — refresh OAuth token

## Required Spotify Scopes

```
playlist-modify-public
playlist-modify-private
playlist-read-private
user-library-read
user-read-recently-played
user-top-read
```

## Config Schema (config.yaml)

```yaml
spotify:
  client_id: string       # From Spotify Developer Dashboard
  client_secret: string   # From Spotify Developer Dashboard
  redirect_uri: string    # Must match dashboard setting

playlist_id: string       # Target playlist to populate

podcasts:                 # Array of podcast sources
  - name: string          # Display name
    id: string            # Spotify show ID
    episodes: number      # How many recent episodes (default: 1)

music:
  playlists:              # Array of playlist sources
    - name: string
      id: string
  total_songs: number     # Total songs to include (default: 15)
  shuffle: boolean        # Shuffle songs (default: true)

mix_pattern: string       # e.g., "PMMM" (default: "PMMM")

schedule:
  time: string            # HH:MM format (used by systemd timer)
  timezone: string        # IANA timezone
```

## Common Tasks for AI Assistants

### "Add support for liked/saved songs as a music source"
- Use `spotifyApi.getMySavedTracks()` in `fetchMusicTracks()`
- Add a `liked_songs: true` option to the `music` config section
- Paginate with offset (API returns max 50 per call)

### "Add support for Spotify recommendations"
- **WARNING:** The `/v1/recommendations` endpoint was DEPRECATED in Nov 2024 and fully removed Feb 2026
- Workaround: use `spotifyApi.getMyTopTracks()` and `spotifyApi.getMyRecentlyPlayedTracks()` as music sources
- Or use search with the user's top artists to find similar music
- `/artists/{id}/top-tracks` was also removed Feb 2026

### "Add multiple playlist targets"
- Change `playlist_id` to an array of `playlists` in config
- Loop over them in `main()`, each can have its own podcasts/music/pattern

### "Add a web UI"
- Express is already a dependency
- Add routes for config editing and manual trigger
- Serve a simple HTML page with forms

## Testing

- Use `npm test` (runs `--dry-run`) to verify logic without modifying Spotify
- The dry run prints the full playlist that would be created
- No test framework is set up — add one if needed (Jest recommended)

## Spotify API Restrictions (as of March 2026)

- **Dev Mode requires Premium** and limits to **5 authorized users** per Client ID
- `/v1/recommendations` endpoint — **REMOVED** (Nov 2024 deprecated, Feb 2026 removed)
- `/artists/{id}/top-tracks` — **REMOVED** (Feb 2026)
- Audio features (valence, energy, danceability) — **DEPRECATED** (Nov 2024)
- Search results capped at 10 per query in Dev Mode
- `http://localhost` redirect URIs — **NO LONGER ALLOWED** (Nov 2025), must use `http://127.0.0.1`
- Implicit grant flow — **REMOVED** (Nov 2025)
- For more: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide

## Gotchas

- Spotify tokens expire after 1 hour, but the script auto-refreshes them using the refresh token
- Refresh tokens can eventually expire after months of inactivity — user must re-run `npm run setup`
- `replaceTracksInPlaylist()` accepts both `spotify:track:` and `spotify:episode:` URIs
- Spotify API rate limit is generous for personal use but can hit 429 with rapid calls
- Podcast episode IDs change with each new episode — always fetch fresh
