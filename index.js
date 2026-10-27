#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script
// =============================================================================
// Builds your custom Daily Drive playlist by mixing podcasts and music.
// This recreates Spotify's discontinued "Daily Drive" feature.
//
// Usage:
//   npm start                     Full refresh: new music + podcasts
//   npm test                      Dry run: shows what would happen
//   node index.js --dry-run       Same as npm test
//   node index.js --podcast-only  Hourly mode: fresh podcasts, reused music
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
    console.error("❌ config.yaml not found! Run: cp config.example.yaml config.yaml");
    process.exit(1);
  }
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

/**
 * Loads the saved OAuth token from disk. Exits if not found.
 * The token file is created when you run `npm run setup` for the first time.
 */
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error("❌ Not authenticated! Run: npm run setup");
    process.exit(1);
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
 * Removes duplicate tracks from a combined music pool.
 *
 * It first removes exact duplicates by Spotify URI. It then removes
 * near-duplicates by normalized track name and artist, which catches cases
 * where Spotify exposes the same recording through different track entries.
 */
function deduplicateTracks(tracks) {
  const beforeDedup = tracks.length;
  const seenUris = new Set();
  const seenSongKeys = new Set();

  const uniqueTracks = tracks.filter((track) => {
    if (!track) return false;

    if (track.uri && seenUris.has(track.uri)) return false;
    if (track.uri) seenUris.add(track.uri);

    const nameKey = (track.name || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    const artistKey = (track.artist || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    const songKey = `${nameKey}|||${artistKey}`;

    if (seenSongKeys.has(songKey)) return false;
    seenSongKeys.add(songKey);

    return true;
  });

  console.log(`🎵 Final mix deduplicated: ${beforeDedup} -> ${uniqueTracks.length}`);

  return uniqueTracks;
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

/**
 * Parses "35-35-30" into percentage shares for top tracks, playlists, and genres.
 */
function parseSharePattern(pattern, topEnabled, playlistsEnabled, genresEnabled) {
  const fallback = {
    top: topEnabled ? 50 : 0,
    playlists: playlistsEnabled ? 50 : 0,
    genres: genresEnabled ? 50 : 0,
  };

  if (!pattern || typeof pattern !== "string") {
    return normalizeShares(fallback);
  }

  const parts = pattern.split("-").map((value) => Number(value.trim()));

  if (
    parts.length !== 3 ||
    parts.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    console.warn(
      `⚠️ Invalid share_pattern "${pattern}". Expected e.g. "35-35-30". Using fallback.`
    );
    return normalizeShares(fallback);
  }

  return normalizeShares({
    top: parts[0],
    playlists: parts[1],
    genres: parts[2],
  });
}

/**
 * Normalizes shares so they always total 100.
 */
function normalizeShares(shares) {
  const total = shares.top + shares.playlists + shares.genres;

  if (total === 0) {
    return { top: 100, playlists: 0, genres: 0 };
  }

  return {
    top: Math.round((shares.top / total) * 100),
    playlists: Math.round((shares.playlists / total) * 100),
    genres: Math.round((shares.genres / total) * 100),
  };
}

// =============================================================================
// Podcast Fetching
// =============================================================================

/**
 * Fetches podcast episodes according to each podcast's configured mode.
 *
 * Modes:
 *   newest                 Always use the newest episode.
 *   oldest_unplayed        Scan recent episodes and use the oldest unfinished one.
 *   alternate_if_finished  Use the newest episode unless it is finished, then
 *                          try the newest unfinished episode from each alternate.
 */
async function fetchPodcastEpisodes(spotifyApi, podcasts) {
  const episodes = [];

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;
    const mode = podcast.mode || "newest";

    console.log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name} (mode: ${mode})`);

    try {
      if (mode === "oldest_unplayed") {
        const selected = await fetchOldestUnplayedEpisodes(spotifyApi, podcast, count);

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

        continue;
      }

      if (mode === "alternate_if_finished") {
        const selected = await fetchEpisodeWithAlternates(spotifyApi, podcast);

        if (selected) {
          episodes.push({
            uri: selected.episode.uri,
            name: selected.episode.name,
            show: selected.showName,
            type: "episode",
            position: podcast.position || null,
          });

          console.log(`    📌 Selected: ${selected.episode.name} (${selected.showName})`);
        }

        continue;
      }

      // Default: newest
      const data = await spotifyApi.getShowEpisodes(podcast.id, {
        limit: count,
        market: "from_token",
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
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
    }
  }

  return episodes;
}

/**
 * Scans a show's recent episodes and selects the oldest unfinished episodes.
 * Falls back to the newest episodes when every scanned episode is finished.
 */
async function fetchOldestUnplayedEpisodes(spotifyApi, podcast, count) {
  const scanLimit = podcast.scan_limit || 50;
  const batchSize = 50;
  const unplayed = [];

  let offset = 0;
  let scanned = 0;

  while (scanned < scanLimit) {
    const limit = Math.min(batchSize, scanLimit - scanned);

    const data = await spotifyApi.getShowEpisodes(podcast.id, {
      limit,
      offset,
      market: "from_token",
    });

    const items = data.body.items;

    if (items.length === 0) break;

    for (const episode of items) {
      const status = episode.resume_point?.fully_played ? "✅ played" : "⬜ unplayed";
      console.log(`    ${status}  ${episode.name}`);

      if (!episode.resume_point?.fully_played) {
        unplayed.push(episode);
      }
    }

    scanned += items.length;
    offset += items.length;

    if (items.length < limit) break;

    console.log(
      `    📊 Scanned ${scanned}/${scanLimit} episodes, ${unplayed.length} unplayed so far...`
    );
  }

  console.log(`    📊 Scan complete: ${scanned} episodes scanned, ${unplayed.length} unplayed found`);

  unplayed.reverse();

  if (unplayed.length === 0) {
    console.log("    ℹ️  No unplayed episodes found — falling back to newest");

    const fallback = await spotifyApi.getShowEpisodes(podcast.id, {
      limit: count,
      market: "from_token",
    });

    return fallback.body.items;
  }

  return unplayed.slice(0, count);
}

/**
 * Checks the main show's newest episode. If it is fully played, checks each
 * alternate show's newest episode until an unfinished one is found.
 */
async function fetchEpisodeWithAlternates(spotifyApi, podcast) {
  const showsToTry = [
    { name: podcast.name, id: podcast.id },
    ...(podcast.alternates || []),
  ];

  for (const show of showsToTry) {
    console.log(`    🔍 Checking newest episode from: ${show.name}`);

    const data = await spotifyApi.getShowEpisodes(show.id, {
      limit: 1,
      market: "from_token",
    });

    const newestEpisode = data.body.items[0];

    if (!newestEpisode) {
      console.log(`    ⚠️  No episodes found for ${show.name}; trying next option...`);
      continue;
    }

    if (newestEpisode.resume_point?.fully_played === true) {
      console.log(
        `    ⏭️  Already finished: ${newestEpisode.name}; trying next option...`
      );
      continue;
    }

    return {
      episode: newestEpisode,
      showName: show.name,
    };
  }

  console.log(
    `    ℹ️  No unfinished newest episode found for ${podcast.name} or its alternates`
  );

  return null;
}

// =============================================================================
// Music Fetching
// =============================================================================

/**
 * Fetches familiar music from configured playlists and the user's top tracks.
 */
async function fetchMusicTracks(spotifyApi, musicConfig) {
  let allTracks = [];

  if (musicConfig.top_tracks && musicConfig.top_tracks.enabled) {
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;

    console.log(`🎵 Fetching top tracks (${timeRange})...`);

    try {
      let offset = 0;
      let remaining = count;

      while (remaining > 0) {
        const limit = Math.min(remaining, 50);

        const data = await spotifyApi.getMyTopTracks({
          limit,
          offset,
          time_range: timeRange,
        });

        for (const track of data.body.items) {
          allTracks.push({
            uri: track.uri,
            name: track.name,
            artist:
              track.artists?.map((artist) => artist.name).join(", ") ||
              "Unknown",
            type: "track",
          });
        }

        if (data.body.items.length < limit) break;

        offset += limit;
        remaining -= limit;
      }

      console.log(`    Found ${allTracks.length} tracks from top tracks`);
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch top tracks: ${err.message}`);
    }
  }

  const totalSongs = musicConfig.total_songs || 15;

  if (musicConfig.shuffle !== false) {
    allTracks = shuffle(allTracks);
  }

  allTracks = allTracks.slice(0, totalSongs);

  console.log(`🎵 Selected ${allTracks.length} songs`);

  return allTracks;
}


/**
 * Fetches discovery tracks by searching Spotify for each configured genre.
 */
async function fetchGenreTracks(spotifyApi, genres, count) {
  const tracks = [];
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    console.log(`🎵 Searching for ${genre} tracks...`);

    try {
      const offset = Math.floor(Math.random() * 5) * 10;

      const data = await spotifyApi.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, 10),
        offset,
        market: "from_token",
      });

      for (const track of data.body.tracks.items) {
        tracks.push({
          uri: track.uri,
          name: track.name,
          artist:
            track.artists?.map((artist) => artist.name).join(", ") || "Unknown",
          type: "track",
        });
      }

      console.log(`    Found ${data.body.tracks.items.length} tracks`);
    } catch (err) {
      console.error(`    ⚠️  Failed to search genre ${genre}: ${err.message}`);
    }
  }

  return shuffle(tracks).slice(0, count);
}

/**
 * Fetches tracks from configured Spotify playlists.
 * Used as its own music source so playlist share can be configured separately.
 */
async function fetchPlaylistTracks(spotifyApi, playlists, count) {
  const tracks = [];
  const accessToken = spotifyApi.getAccessToken();

  for (const playlist of playlists) {
    if (!playlist.id || playlist.id === "your-playlist-id") continue;

    console.log(`🎵 Fetching tracks from playlist: ${playlist.name}`);

    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await fetch(
          `https://api.spotify.com/v1/playlists/${playlist.id}/items?limit=100&offset=${offset}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();

        for (const entry of data.items || []) {
          const track = entry.item;

          if (track && track.uri && track.type === "track") {
            tracks.push({
              uri: track.uri,
              name: track.name,
              artist:
                track.artists?.map((artist) => artist.name).join(", ") ||
                "Unknown",
              type: "track",
            });
          }
        }

        offset += 100;
        hasMore = offset < (data.total || 0);
      }

      console.log(`    Found ${tracks.length} playlist tracks so far`);
    } catch (err) {
      console.error(
        `    ⚠️  Failed to fetch playlist ${playlist.name}: ${err.message}`
      );
    }
  }

  return shuffle(tracks).slice(0, count);
}

/**
 * Fetches music from top tracks, configured playlists, and genre discovery.
 * The relative share of each source is controlled by music.share_pattern.
 *
 * share_pattern format: "top-playlists-genres"
 * Example: "35-35-30" = 35% top tracks, 35% playlist tracks, 30% genre discovery
 */
async function fetchAllMusicTracks(spotifyApi, config) {
  const musicConfig = config.music || {};
  const totalSongs = musicConfig.total_songs || 15;

  const shares = parseSharePattern(
    musicConfig.share_pattern,
    musicConfig.top_tracks?.enabled,
    musicConfig.playlists?.length > 0,
    musicConfig.genres?.length > 0
  );

  const topCount = Math.round((totalSongs * shares.top) / 100);
  const playlistCount = Math.round((totalSongs * shares.playlists) / 100);
  let genreCount = totalSongs - topCount - playlistCount;

  if (genreCount < 0) genreCount = 0;

  console.log(
    `🎵 Music share pattern: ${shares.top}% top tracks, ${shares.playlists}% playlists, ${shares.genres}% genre discovery`
  );
  console.log(
    `🎵 Target counts: ${topCount} top tracks, ${playlistCount} playlist tracks, ${genreCount} genre discovery`
  );

  let tracks = [];

  if (topCount > 0) {
    const topConfig = {
      ...musicConfig,
      playlists: [],
      total_songs: topCount,
    };

    const topTracks = await fetchMusicTracks(spotifyApi, topConfig);
    tracks.push(...topTracks);
  }

  if (playlistCount > 0 && musicConfig.playlists?.length > 0) {
    const playlistTracks = await fetchPlaylistTracks(
      spotifyApi,
      musicConfig.playlists,
      playlistCount
    );

    tracks.push(...playlistTracks);
  }

  if (genreCount > 0 && musicConfig.genres?.length > 0) {
    const genreTracks = await fetchGenreTracks(
      spotifyApi,
      musicConfig.genres,
      genreCount
    );

    tracks.push(...genreTracks);
  }

  tracks = deduplicateTracks(tracks);

  console.log(`🎵 Final mix deduplicated: ${tracks.length} tracks after dedup`);

  if (musicConfig.shuffle !== false) {
    tracks = shuffle(tracks);
  }

  return tracks.slice(0, totalSongs);
}


// =============================================================================
// Playlist Mixing and Updating
// =============================================================================

/**
 * Interleaves podcast episodes and music tracks according to a pattern.
 *
 * Pattern characters:
 *   P = podcast episode
 *   M = music track
 */
function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  const mixPattern = pattern || "PMMM";

  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;

  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    const slot = mixPattern[patternIndex % mixPattern.length];

    if ((slot === "P" || slot === "p") && episodeIndex < episodes.length) {
      mixed.push(episodes[episodeIndex++]);
    } else if (trackIndex < tracks.length) {
      mixed.push(tracks[trackIndex++]);
    }

    patternIndex++;

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
 * Replaces the target playlist with the final mixed items.
 */
async function updatePlaylist(spotifyApi, playlistId, items) {
  const uris = items.map((item) => item.uri);

  if (DRY_RUN) {
    console.log("\n🧪 DRY RUN — would update playlist with:\n");

    items.forEach((item, index) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail =
        item.type === "episode"
          ? `[${item.show}] ${item.name}`
          : `${item.name} — ${item.artist}`;

      console.log(`  ${String(index + 1).padStart(2)}. ${icon} ${detail}`);
    });

    console.log(`\n✅ Dry run complete. ${items.length} items would be added.\n`);

    return;
  }

  const accessToken = spotifyApi.getAccessToken();

  const clearResponse = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/items`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: uris.slice(0, 100) }),
    }
  );

  if (!clearResponse.ok) {
    const error = await clearResponse.text();
    throw new Error(
      `Failed to update playlist: ${clearResponse.status} ${error}`
    );
  }

  for (let index = 100; index < uris.length; index += 100) {
    const batch = uris.slice(index, index + 100);

    const addResponse = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: batch }),
      }
    );

    if (!addResponse.ok) {
      const error = await addResponse.text();
      throw new Error(`Failed to add batch: ${addResponse.status} ${error}`);
    }
  }

  const episodeCount = items.filter((item) => item.type === "episode").length;
  const trackCount = items.filter((item) => item.type === "track").length;

  console.log(`\n✅ Playlist updated with ${items.length} items!`);
  console.log(`   🎙️  ${episodeCount} podcast episodes`);
  console.log(`   🎵 ${trackCount} songs\n`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const mode = PODCAST_ONLY ? "podcast-only" : "full";

  console.log(
    `\n🚗 Daily Drive — ${
      PODCAST_ONLY ? "Hourly podcast refresh" : "Full playlist rebuild"
    }...\n`
  );

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

  if (
    !config.playlist_id ||
    config.playlist_id === "your-playlist-id-here"
  ) {
    console.error("❌ Please set your playlist_id in config.yaml");
    process.exit(1);
  }

  const episodes = await fetchPodcastEpisodes(
    spotifyApi,
    config.podcasts || []
  );

  const state = loadState();
  const currentEpisodeUris = episodes
    .map((episode) => episode.uri)
    .sort()
    .join(",");
  const previousEpisodeUris = state.episode_uris || "";

  if (
    !DRY_RUN &&
    PODCAST_ONLY &&
    currentEpisodeUris === previousEpisodeUris &&
    episodes.length > 0
  ) {
    console.log("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    console.log(
      "   (Same episodes as last update — skipping to avoid disruption)\n"
    );
    process.exit(0);
  }

  let tracks;

  if (PODCAST_ONLY) {
    if (state.music_tracks && state.music_tracks.length > 0) {
      tracks = state.music_tracks;
      console.log(
        `🎵 Reusing ${tracks.length} saved music tracks from last full refresh`
      );
    } else {
      console.log(
        "⚠️  No saved music tracks found — falling back to full music fetch"
      );
      tracks = await fetchAllMusicTracks(spotifyApi, config);
    }
  } else {
    tracks = await fetchAllMusicTracks(spotifyApi, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    console.error("❌ No content found! Check your config.yaml settings.");
    process.exit(1);
  }

  const pinnedFirst = [];
  const mixableEpisodes = [];

  for (const episode of episodes) {
    if (episode.position === "first") {
      pinnedFirst.push(episode);
    } else {
      mixableEpisodes.push(episode);
    }
  }

  console.log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);

  const mixed = [
    ...pinnedFirst,
    ...mixContent(mixableEpisodes, tracks, config.mix_pattern),
  ];

  await updatePlaylist(spotifyApi, config.playlist_id, mixed);

  if (!DRY_RUN) {
    const newState = {
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
    };

    if (PODCAST_ONLY) {
      newState.music_tracks = state.music_tracks || tracks;
      newState.last_full_refresh = state.last_full_refresh || null;
    } else {
      newState.music_tracks = tracks;
      newState.last_full_refresh = new Date().toISOString();
    }

    saveState(newState);
    console.log("💾 State saved to state.json");
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);

  if (err.statusCode === 401) {
    console.error("   Your token may have expired. Run: npm run setup\n");
  }

  process.exit(1);
});
