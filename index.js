#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script
// =============================================================================
// Builds your custom Daily Drive playlist by mixing podcasts and music.
//
// Usage:  npm start              (update the playlist)
//         npm test               (dry run — shows what would happen)
//         node index.js --dry-run
// =============================================================================

const fs = require("fs");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");

const TOKEN_FILE = ".spotify-token.json";
const CONFIG_FILE = "config.yaml";
const STATE_FILE = "state.json";
const DRY_RUN = process.argv.includes("--dry-run");

// =============================================================================
// Helper Functions
// =============================================================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("❌ config.yaml not found! Run: cp config.example.yaml config.yaml");
    process.exit(1);
  }
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error("❌ Not authenticated! Run: npm run setup");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function refreshTokenIfNeeded(spotifyApi, token) {
  // Refresh if token expires in less than 5 minutes
  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    console.log("🔄 Refreshing access token...");
    const data = await spotifyApi.refreshAccessToken();
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;
    if (data.body.refresh_token) {
      token.refresh_token = data.body.refresh_token;
    }
    saveToken(token);
    spotifyApi.setAccessToken(token.access_token);
    console.log("✅ Token refreshed");
  }
}

// =============================================================================
// Core Logic
// =============================================================================

async function fetchPodcastEpisodes(spotifyApi, podcasts) {
  const episodes = [];

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;
    console.log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name}`);

    try {
      const data = await spotifyApi.getShowEpisodes(podcast.id, {
        limit: count,
        market: "US",
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

async function fetchMusicTracks(spotifyApi, musicConfig) {
  let allTracks = [];

  // Fetch from playlists
  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      if (!playlist.id || playlist.id === "your-playlist-id") continue;

      console.log(`🎵 Fetching songs from playlist: ${playlist.name}`);

      try {
        // Fetch up to 100 tracks (paginate if needed for larger playlists)
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const data = await spotifyApi.getPlaylistTracks(playlist.id, {
            limit: 100,
            offset,
            fields:
              "items(track(uri,name,artists)),total",
          });

          for (const item of data.body.items) {
            if (item.track && item.track.uri) {
              allTracks.push({
                uri: item.track.uri,
                name: item.track.name,
                artist: item.track.artists?.map((a) => a.name).join(", ") || "Unknown",
                type: "track",
              });
            }
          }

          offset += 100;
          hasMore = offset < data.body.total;
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

  // Fetch from user's top tracks
  if (musicConfig.top_tracks && musicConfig.top_tracks.enabled) {
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;
    console.log(`🎵 Fetching top tracks (${timeRange})...`);

    try {
      let offset = 0;
      let remaining = count;

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

        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      console.log(`    Found ${allTracks.length} tracks from top tracks`);
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch top tracks: ${err.message}`);
    }
  }

  // Shuffle and trim to desired count
  const totalSongs = musicConfig.total_songs || 15;
  if (musicConfig.shuffle !== false) {
    allTracks = shuffle(allTracks);
  }
  allTracks = allTracks.slice(0, totalSongs);

  console.log(`🎵 Selected ${allTracks.length} songs`);
  return allTracks;
}

async function fetchGenreTracks(spotifyApi, genres, count) {
  const tracks = [];
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    console.log(`🎵 Searching for ${genre} tracks...`);
    try {
      const data = await spotifyApi.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, 10), // Dev Mode caps at 10 per query
        market: "US",
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

  return shuffle(tracks).slice(0, count);
}

function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;

  const mixPattern = pattern || "PMMM";

  // Keep going until we've placed all content
  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    const slot = mixPattern[patternIndex % mixPattern.length];

    if (slot === "P" || slot === "p") {
      if (episodeIndex < episodes.length) {
        mixed.push(episodes[episodeIndex++]);
      }
    } else {
      // M = music
      if (trackIndex < tracks.length) {
        mixed.push(tracks[trackIndex++]);
      }
    }

    patternIndex++;

    // Safety valve: if one type is exhausted, dump the rest of the other
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

async function updatePlaylist(spotifyApi, playlistId, items) {
  const uris = items.map((item) => item.uri);

  if (DRY_RUN) {
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

  // Use /items endpoint (Spotify migrated from /tracks in Feb 2026)
  const accessToken = spotifyApi.getAccessToken();

  // Clear playlist first
  const clearRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!clearRes.ok) {
    const err = await clearRes.text();
    throw new Error(`Failed to update playlist: ${clearRes.status} ${err}`);
  }

  // Add remaining batches if any
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
  console.log(`   🎙️  ${items.filter((i) => i.type === "episode").length} podcast episodes`);
  console.log(`   🎵 ${items.filter((i) => i.type === "track").length} songs\n`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("\n🚗 Daily Drive — Building your playlist...\n");

  const config = loadConfig();
  const token = loadToken();

  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });

  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);

  // Refresh token if needed
  await refreshTokenIfNeeded(spotifyApi, token);

  // Validate playlist ID
  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    console.error("❌ Please set your playlist_id in config.yaml");
    process.exit(1);
  }

  // Fetch content
  const episodes = await fetchPodcastEpisodes(spotifyApi, config.podcasts || []);

  // State cache: check if episodes have changed since last run
  const state = loadState();
  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  if (!DRY_RUN && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    console.log("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    console.log("   (Same episodes as last update — skipping to avoid disruption)\n");
    process.exit(0);
  }

  // Fetch music — split between familiar (top tracks/playlists) and discovery (genres)
  const musicConfig = config.music || {};
  const totalSongs = musicConfig.total_songs || 15;
  const hasGenres = musicConfig.genres && musicConfig.genres.length > 0;

  // If genres are configured, split 50/50 between familiar and discovery
  // Otherwise, all songs come from familiar sources
  const familiarCount = hasGenres ? Math.ceil(totalSongs / 2) : totalSongs;
  const discoveryCount = hasGenres ? totalSongs - familiarCount : 0;

  // Fetch familiar tracks (top tracks + playlists)
  const familiarConfig = { ...musicConfig, total_songs: familiarCount };
  let tracks = await fetchMusicTracks(spotifyApi, familiarConfig);

  // Fetch discovery tracks (genre search)
  if (hasGenres && discoveryCount > 0) {
    const genreTracks = await fetchGenreTracks(spotifyApi, musicConfig.genres, discoveryCount);
    // Deduplicate: remove genre tracks that are already in familiar
    const familiarUris = new Set(tracks.map((t) => t.uri));
    const newGenreTracks = genreTracks.filter((t) => !familiarUris.has(t.uri));
    tracks = [...tracks, ...newGenreTracks.slice(0, discoveryCount)];
    console.log(`🎵 Music mix: ${familiarCount} familiar + ${newGenreTracks.slice(0, discoveryCount).length} discovery = ${tracks.length} total`);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    console.error("❌ No content found! Check your config.yaml settings.");
    process.exit(1);
  }

  // Separate pinned episodes from the rest
  const pinnedFirst = [];
  const mixableEpisodes = [];
  for (const ep of episodes) {
    if (ep.position === "first") {
      pinnedFirst.push(ep);
    } else {
      mixableEpisodes.push(ep);
    }
  }

  // Mix content according to pattern
  console.log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  // Update the playlist
  await updatePlaylist(spotifyApi, config.playlist_id, mixed);

  // Persist state for next run
  if (!DRY_RUN) {
    saveState({
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
    });
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
