#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script
// =============================================================================
// Builds your custom Daily Drive playlist by mixing podcasts and music.
// This recreates Spotify's discontinued "Daily Drive" feature.
//
// Usage:  npm start                  (full refresh — new music + podcasts)
//         npm test                   (dry run — shows what would happen)
//         node index.js --dry-run
//         node index.js --podcast-only  (hourly mode — fresh podcasts, reuses today's music)
// =============================================================================

// --- Node.js built-in modules ---
const fs = require("fs");

// --- Third-party libraries (installed via npm install) ---
const yaml = require("js-yaml");               // Parses YAML config files
const SpotifyWebApi = require("spotify-web-api-node"); // Wraps the Spotify Web API

// --- File paths used by the script ---
const TOKEN_FILE = ".spotify-token.json";  // Stores your Spotify OAuth tokens (created by setup.js)
const CONFIG_FILE = "config.yaml";         // Your configuration (podcasts, music, schedule, etc.)
const STATE_FILE = "state.json";           // Caches last run's episode URIs to detect changes

// Check command-line flags
const DRY_RUN = process.argv.includes("--dry-run");       // Shows what would happen without changing the playlist
const PODCAST_ONLY = process.argv.includes("--podcast-only"); // Hourly mode: only refresh podcasts, reuse saved music

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Loads and parses config.yaml. Exits with an error if the file doesn't exist.
 * This file contains your Spotify credentials, podcast list, music preferences, etc.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error("config.yaml not found! Run: cp config.example.yaml config.yaml");
  }
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

/**
 * Loads the saved OAuth token from disk. Exits if not found.
 * The token file is created when you run `npm run setup` for the first time.
 */
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error("Not authenticated! Run: npm run setup");
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

/**
 * Saves the OAuth token back to disk (called after a token refresh).
 */
function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

/**
 * Loads the state file that tracks which episodes were in the last playlist update.
 * Returns an empty object if the file doesn't exist or is corrupted.
 */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Saves state to disk so the next run can compare episodes and skip if nothing changed.
 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Fisher-Yates shuffle — randomizes an array in-place.
 * Used to shuffle music tracks so the playlist feels fresh each time.
 */
function shuffle(array) {
  const arr = [...array]; // Create a copy so we don't modify the original
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]; // Swap elements
  }
  return arr;
}

/**
 * Removes duplicate items from an array based on their URI.
 * Keeps the first occurrence of each URI; subsequent occurrences are removed.
 *
 * This prevents the same song or episode from appearing multiple times in the
 * playlist when it's fetched from different sources (e.g., top tracks + playlists,
 * or familiar music + genre discovery).
 *
 * @param {Array} items - Array of objects with a `uri` property
 * @param {string} label - Optional label for logging (e.g., "tracks", "episodes")
 * @returns {Array} - Deduplicated array with logging output
 */
function removeDuplicates(items, label = "items") {
  const seen = new Set();
  const deduplicated = [];
  let duplicateCount = 0;

  for (const item of items) {
    const dedupeKey = item.type === "track" && item.isrc ? item.isrc : item.uri;

    if (!dedupeKey) {
      // Items without a usable dedupe key are kept (shouldn't happen, but be safe)
      deduplicated.push(item);
      continue;
    }

    if (seen.has(dedupeKey)) {
      duplicateCount++;
      console.log(
        `    ⏭️  Skipping duplicate: ${item.name} (${item.type === "episode" ? item.show : item.artist})`
      );
    } else {
      seen.add(dedupeKey);
      deduplicated.push(item);
    }
  }

  if (duplicateCount > 0) {
    console.log(`    🔄 Removed ${duplicateCount} duplicate ${label}`);
  }

  return deduplicated;
}

/**
 * Spotify access tokens expire after 1 hour. This function checks if the token
 * is about to expire (within 5 minutes) and refreshes it automatically using
 * the long-lived refresh token. You don't need to re-authenticate manually.
 */
async function refreshTokenIfNeeded(spotifyApi, token) {
  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    console.log("🔄 Refreshing access token...");
    const data = await spotifyApi.refreshAccessToken();

    // Update the token in memory
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;

    // Spotify sometimes rotates the refresh token too — save it if provided
    if (data.body.refresh_token) {
      token.refresh_token = data.body.refresh_token;
    }

    // Persist to disk and update the API client
    saveToken(token);
    spotifyApi.setAccessToken(token.access_token);
    console.log("✅ Token refreshed");
  }
}

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Fetches podcast episodes based on the configured mode per podcast:
 *   - "newest" (default): grabs the most recent episode(s)
 *   - "newest_unplayed": scans recent episodes and picks the most recent
 *     episode(s) that Spotify hasn't marked as fully played
 *   - "oldest_unplayed": scans recent episodes and picks the oldest one
 *     that Spotify hasn't marked as fully played yet
 *
 * The unplayed modes use Spotify's resume_point.fully_played field, which is
 * returned when the market parameter is set. They scan up to scan_limit
 * episodes (default: 50) and select from the newest or oldest end. The
 * newest-unplayed mode stops as soon as it has enough candidates.
 *
 * Falls back to newest if no unplayed episodes are found.
 */
async function fetchPodcastEpisodes(spotifyApi, podcasts, market) {
  const episodes = [];

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;
    const mode = podcast.mode || "newest";

    console.log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name} (mode: ${mode})`);

    try {
      if (mode === "oldest_unplayed" || mode === "newest_unplayed") {
        // Scan through episodes in batches of 50 (Spotify API max per request)
        const scanLimit = podcast.scan_limit || 50;
        const batchSize = 50;
        let offset = 0;
        let scanned = 0;
        const unplayed = [];
        let newestItems = [];

        while (scanned < scanLimit) {
          const limit = Math.min(batchSize, scanLimit - scanned);
          const data = await spotifyApi.getShowEpisodes(podcast.id, {
            limit,
            offset,
            market: market || "US",
          });

          const items = data.body.items;
          if (items.length === 0) break; // No more episodes
          if (scanned === 0) newestItems = items;

          for (const ep of items) {
            const status = ep.resume_point?.fully_played ? "✅ played" : "⬜ unplayed";
            console.log(`    ${status}  ${ep.name}`);

            if (!ep.resume_point?.fully_played) {
              unplayed.push(ep);
            }
          }

          scanned += items.length;
          offset += items.length;

          // Spotify returns newest first, so more pages cannot improve this
          // result once newest-unplayed has enough episodes.
          if (mode === "newest_unplayed" && unplayed.length >= count) break;

          // If we got fewer than requested, we've reached the end
          if (items.length < limit) break;

          console.log(`    📊 Scanned ${scanned}/${scanLimit} episodes, ${unplayed.length} unplayed so far...`);
        }

        console.log(`    📊 Scan complete: ${scanned} episodes scanned, ${unplayed.length} unplayed found`);

        // Spotify returns newest first. Reverse only for oldest-unplayed mode.
        if (mode === "oldest_unplayed") unplayed.reverse();

        let selected;
        if (unplayed.length === 0) {
          console.log(`    ℹ️  No unplayed episodes found — falling back to newest`);
          // The first scan already contains the newest episodes.
          selected = newestItems.slice(0, count);
        } else {
          selected = unplayed.slice(0, count);
        }

        for (const episode of selected) {
          episodes.push({
            uri: episode.uri,
            name: episode.name,
            show: podcast.name,
            type: "episode",
            position: podcast.position || null,
          });
          console.log(`    📌 Selected: ${episode.name}`);
        }
      } else {
        // Default "newest" mode — original behavior
        const data = await spotifyApi.getShowEpisodes(podcast.id, {
          limit: count,
          market: market || "US",
        });

        for (const episode of data.body.items) {
          episodes.push({
            uri: episode.uri,
            name: episode.name,
            show: podcast.name,
            type: "episode",
            position: podcast.position || null,
          });
          console.log(`    📌 ${episode.name}`);
        }
      }
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
    }
  }

  return episodes;
}

/**
 * Fetches music tracks from two "familiar" sources:
 *   1. Source playlists — songs from playlists you specify in config.yaml
 *   2. Top tracks — your most-played songs on Spotify
 *
 * Tracks are shuffled and trimmed to the requested count.
 */
async function fetchMusicTracks(spotifyApi, musicConfig, market) {
  let allTracks = [];

  // --- Source 1: Pull tracks from user-specified playlists ---
  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      // Skip placeholder entries from the example config
      if (!playlist.id || playlist.id === "your-playlist-id") continue;

      console.log(`🎵 Fetching songs from playlist: ${playlist.name}`);

      try {
        // Spotify returns max 100 items per request, so we paginate through
        // larger playlists by incrementing the offset
        const accessToken = spotifyApi.getAccessToken();
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          // IMPORTANT: We use the /items endpoint directly via fetch() because
          // the spotify-web-api-node library's getPlaylistTracks() still hits
          // the old /tracks endpoint, which Spotify deprecated in Feb 2026 and
          // now returns 403 Forbidden.
          const res = await fetch(
            `https://api.spotify.com/v1/playlists/${playlist.id}/items?limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          }

          const data = await res.json();

          for (const entry of data.items) {
            // The /items endpoint returns the content in entry.item (not entry.track)
            const track = entry.item;
            if (track && track.uri && track.type === "track") {
              allTracks.push({
                uri: track.uri,
                name: track.name,
                artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
                type: "track",
              });
            }
          }

          offset += 100;
          hasMore = offset < data.total;
        }

        console.log(
          `    Found ${allTracks.length} tracks so far`
        );
      } catch (err) {
        console.error(
          `    ⚠️  Failed to fetch playlist ${playlist.name}: ${err.message}`
        );
      }
    }
  }

  // --- Source 2: Pull from user's top tracks (most-played songs) ---
  if (musicConfig.top_tracks && musicConfig.top_tracks.enabled) {
    // time_range controls the window:
    //   "short_term"  = last ~4 weeks
    //   "medium_term" = last ~6 months
    //   "long_term"   = all time
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;
    console.log(`🎵 Fetching top tracks (${timeRange})...`);

    try {
      let offset = 0;
      let remaining = count;

      // Spotify returns max 50 top tracks per request, so paginate if needed
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        const data = await spotifyApi.getMyTopTracks({ limit, offset, time_range: timeRange });

        for (const track of data.body.items) {
          allTracks.push({
            uri: track.uri,
            name: track.name,
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
            type: "track",
          });
        }

        // If we got fewer tracks than requested, there are no more
        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      console.log(`    Found ${allTracks.length} tracks from top tracks`);
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch top tracks: ${err.message}`);
    }
  }

  // Remove duplicate tracks before shuffling and trimming
  allTracks = removeDuplicates(allTracks, "tracks");

  // Shuffle and trim to the desired total number of songs
  const totalSongs = musicConfig.total_songs || 15;
  if (musicConfig.shuffle !== false) {
    allTracks = shuffle(allTracks);
  }
  allTracks = allTracks.slice(0, totalSongs);

  console.log(`🎵 Selected ${allTracks.length} songs`);
  return allTracks;
}

/**
 * Fetches "discovery" tracks by searching Spotify for songs matching your
 * configured genres (e.g., "dance pop", "indie rock"). This helps you discover
 * new music outside your usual listening habits.
 *
 * Tracks are split evenly across genres, then shuffled and trimmed.
 */
async function fetchGenreTracks(spotifyApi, genres, count, market) {
  const tracks = [];
  // Divide the target count evenly among configured genres
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    console.log(`🎵 Searching for ${genre} tracks...`);
    try {
      // Use Spotify's search with a "genre:" filter
      const data = await spotifyApi.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, 10), // Spotify Dev Mode caps search at 10 results per query
        market: market || "US", // Use configured market or default to US
      });

      for (const track of data.body.tracks.items) {
        tracks.push({
          uri: track.uri,
          name: track.name,
          artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
          type: "track",
        });
      }
      console.log(`    Found ${data.body.tracks.items.length} tracks`);
    } catch (err) {
      console.error(`    ⚠️  Failed to search genre ${genre}: ${err.message}`);
    }
  }

  // Shuffle so we don't always get the same top results, then trim to count
  return shuffle(tracks).slice(0, count);
}

/**
 * Interleaves podcast episodes and music tracks according to a pattern string.
 *
 * Pattern example: "PMMM" means: 1 podcast, 3 music, 1 podcast, 3 music, ...
 *   P = podcast episode slot
 *   M = music track slot
 *
 * The pattern repeats cyclically. When one content type runs out, the remaining
 * items of the other type are appended at the end.
 */
function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;

  const mixPattern = pattern || "PMMM";

  // Walk through the pattern, placing content in the appropriate slots
  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    // Which slot are we on? The pattern repeats using modulo (%)
    const slot = mixPattern[patternIndex % mixPattern.length];

    if (slot === "P" || slot === "p") {
      // Podcast slot — place next episode if available
      if (episodeIndex < episodes.length) {
        mixed.push(episodes[episodeIndex++]);
      }
    } else {
      // Music slot (M) — place next track if available
      if (trackIndex < tracks.length) {
        mixed.push(tracks[trackIndex++]);
      }
    }

    patternIndex++;

    // Safety valve: if one type is exhausted, dump all remaining items of the other
    // This prevents an infinite loop when the pattern asks for content we don't have
    if (episodeIndex >= episodes.length && trackIndex < tracks.length) {
      while (trackIndex < tracks.length) {
        mixed.push(tracks[trackIndex++]);
      }
      break;
    }
    if (trackIndex >= tracks.length && episodeIndex < episodes.length) {
      while (episodeIndex < episodes.length) {
        mixed.push(episodes[episodeIndex++]);
      }
      break;
    }
  }

  return mixed;
}

/**
 * Replaces the entire playlist with the given items.
 *
 * Uses the Spotify /items endpoint (NOT /tracks, which was deprecated in Feb 2026).
 * PUT replaces the first 100 items; POST appends additional batches if needed.
 * This endpoint accepts both track and episode URIs.
 */
async function updatePlaylist(spotifyApi, playlistId, items, mode, dryRun = DRY_RUN) {
  const uris = items.map((item) => item.uri);

  // In dry-run mode, just print what would happen and return
  if (dryRun) {
    console.log("\n🧪 DRY RUN — would update playlist with:\n");
    items.forEach((item, i) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail =
        item.type === "episode"
          ? `[${item.show}] ${item.name}`
          : `${item.name} — ${item.artist}`;
      console.log(`  ${String(i + 1).padStart(2)}. ${icon} ${detail}`);
    });
    console.log(`\n✅ Dry run complete. ${items.length} items would be added.\n`);
    return;
  }

  // Get the current access token for direct API calls
  const accessToken = spotifyApi.getAccessToken();

  // PUT replaces the entire playlist with up to 100 items at once
  const clearRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!clearRes.ok) {
    const err = await clearRes.text();
    throw new Error(`Failed to update playlist: ${clearRes.status} ${err}`);
  }

  // If we have more than 100 items, POST the remaining in batches of 100
  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
    if (!addRes.ok) {
      const err = await addRes.text();
      throw new Error(`Failed to add batch: ${addRes.status} ${err}`);
    }
  }

  console.log(`\n✅ Playlist updated with ${items.length} items!`);
  const episodeCount = items.filter((i) => i.type === "episode").length;
  const trackCount = items.filter((i) => i.type === "track").length;
  console.log(`   🎙️  ${episodeCount} podcast episodes`);
  console.log(`   🎵 ${trackCount} songs\n`);

  const now = new Date();
  const updatedAt = now.toISOString().replace("T", " ").split(".")[0] + " UTC";
  const modeLabel = mode === "podcast-only" ? "hourly podcast refresh" : "full refresh";
  const description = `Daily Drive updated: ${trackCount} songs, ${episodeCount} episodes, ${modeLabel}. Last updated ${updatedAt}.`;

  await setPlaylistDescription(spotifyApi, playlistId, description);
  console.log("📝 Playlist description updated.");
}

/**
 * Updates the Spotify playlist description with a short debug summary.
 */
async function setPlaylistDescription(spotifyApi, playlistId, description) {
  const accessToken = spotifyApi.getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ description }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update playlist description: ${res.status} ${err}`);
  }
}

// =============================================================================
// Main — Entry point that orchestrates everything
// =============================================================================

async function getAuthenticatedApi() {
  const config = loadConfig();
  const token = loadToken();
  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });
  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);
  await refreshTokenIfNeeded(spotifyApi, token);
  return { spotifyApi, config, token };
}

async function runBuild({ podcastOnly = false, dryRun = DRY_RUN } = {}) {
  const mode = podcastOnly ? "podcast-only" : "full";
  const runTime = new Date().toISOString().replace("T", " ").split(".")[0] + " UTC";
  console.log(`\n🚗 Daily Drive — ${podcastOnly ? "Hourly podcast refresh" : "Full playlist rebuild"}...`);
  console.log(`   🕒 Run started: ${runTime}\n`);

  const { spotifyApi, config } = await getAuthenticatedApi();

  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    throw new Error("Please set your playlist_id in config.yaml");
  }

  const episodes = await fetchPodcastEpisodes(spotifyApi, config.podcasts || [], config.spotify.market);

  const state = loadState();
  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  if (!dryRun && podcastOnly && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    console.log("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    console.log("   (Same episodes as last update — skipping to avoid disruption)\n");
    return { skipped: true, last_updated: state.last_updated || null };
  }

  let tracks;

  if (podcastOnly) {
    if (state.music_tracks && state.music_tracks.length > 0) {
      tracks = state.music_tracks;
      console.log(`🎵 Reusing ${tracks.length} saved music tracks from last full refresh`);
    } else {
      console.log("⚠️  No saved music tracks found — falling back to full music fetch");
      tracks = await fetchAllMusicTracks(spotifyApi, config);
    }
  } else {
    tracks = await fetchAllMusicTracks(spotifyApi, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    throw new Error("No content found! Check your config.yaml settings.");
  }

  // Step 8: Separate pinned episodes (position: "first") from mixable ones
  // Pinned episodes go at the very top of the playlist, before the mix pattern starts
  const pinnedFirst = [];
  const mixableEpisodes = [];
  for (const ep of episodes) {
    if (ep.position === "first") {
      pinnedFirst.push(ep);
    } else {
      mixableEpisodes.push(ep);
    }
  }

  // Step 9: Mix podcasts and music according to the configured pattern
  console.log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  // Step 9a: Final deduplication pass (safety net)
  // This catches any duplicates that might have appeared during mixing
  const finalMixed = removeDuplicates(mixed, "playlist items");

  // Step 10: Push the final mixed playlist to Spotify
  await updatePlaylist(spotifyApi, config.playlist_id, finalMixed, mode, dryRun);

  // Step 11: Save state with detailed item metadata for debugging
  if (!dryRun) {
    const newState = {
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
    };

    if (podcastOnly) {
      newState.music_tracks = state.music_tracks || tracks;
      newState.last_full_refresh = state.last_full_refresh || null;
    } else {
      newState.music_tracks = tracks;
      newState.last_full_refresh = new Date().toISOString();
    }

    saveState(newState);
    console.log("💾 State saved to state.json");
  }

  return { ok: true, skipped: false, last_updated: new Date().toISOString(), count: finalMixed.length };
}

async function main() {
  try {
    const result = await runBuild({ podcastOnly: PODCAST_ONLY });
    if (result.skipped) process.exit(0);
  } catch (err) {
    console.error("\n❌ Error:", err.message);
    if (err.statusCode === 401) {
      console.error("   Your token may have expired. Run: npm run setup\n");
    }
    process.exit(1);
  }
}

/**
 * Fetches all music tracks (familiar + discovery) based on config.
 * Used by full refresh mode, and as a fallback for podcast-only mode
 * when no saved tracks exist yet.
 */
async function fetchAllMusicTracks(spotifyApi, config) {
  const musicConfig = config.music || {};
  const market = config.spotify?.market || "US";
  const totalSongs = musicConfig.total_songs || 15;
  const hasGenres = musicConfig.genres && musicConfig.genres.length > 0;

  // When genres are configured, split total_songs 50/50:
  //   - Half "familiar" (your top tracks + source playlists)
  //   - Half "discovery" (genre search results — new music for you)
  const familiarCount = hasGenres ? Math.ceil(totalSongs / 2) : totalSongs;
  const discoveryCount = hasGenres ? totalSongs - familiarCount : 0;

  // Fetch familiar tracks (your top tracks + any source playlists)
  const familiarConfig = { ...musicConfig, total_songs: familiarCount };
  let tracks = await fetchMusicTracks(spotifyApi, familiarConfig, market);

  // Fetch discovery tracks (genre-based search for new music)
  if (hasGenres && discoveryCount > 0) {
    const genreTracks = await fetchGenreTracks(spotifyApi, musicConfig.genres, discoveryCount, market);

    // Remove any genre tracks that duplicate songs already in the familiar set
    const familiarUris = new Set(tracks.map((t) => t.uri));
    const uniqueGenreTracks = genreTracks.filter((t) => !familiarUris.has(t.uri));
    
    // Log deduplication result
    if (uniqueGenreTracks.length < genreTracks.length) {
      const deduped = genreTracks.length - uniqueGenreTracks.length;
      console.log(`    🔄 Removed ${deduped} duplicate genre track(s) already in familiar music`);
    }
    
    tracks = [...tracks, ...uniqueGenreTracks.slice(0, discoveryCount)];
    console.log(`🎵 Music mix: ${familiarCount} familiar + ${uniqueGenreTracks.slice(0, discoveryCount).length} discovery = ${tracks.length} total`);
  }

  return tracks;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadConfig,
  loadToken,
  getAuthenticatedApi,
  fetchPodcastEpisodes,
  runBuild,
};
