#!/usr/bin/env node
// =============================================================================
// Daily Drive — Taste Profile Generator (Google Gemini — Free)
// =============================================================================
// Analyzes your Spotify top tracks/artists and uses Google Gemini (free tier)
// to generate genre tags for your config.yaml.
//
// Usage:  node taste-profile-google.js
//         npm run taste:google
//
// Requires: GEMINI_API_KEY in .env or environment
//
// --------------------------------------------------------------------------
// How to get a free Google Gemini API key:
//
//   1. Go to https://aistudio.google.com/apikey
//   2. Sign in with your Google account
//   3. Click "Create API key" and select or create a Google Cloud project
//   4. Copy the key (starts with "AIza...")
//   5. Add it to your .env file:
//        GEMINI_API_KEY=AIza...your_key_here
//
// Free tier limits (as of March 2026):
//   - 15 requests per minute
//   - 1 million tokens per day
//   - No credit card required
//
// This is more than enough for taste profile generation (one request per run).
// --------------------------------------------------------------------------

const fs = require("fs");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");

const TOKEN_FILE = ".spotify-token.json";
const CONFIG_FILE = "config.yaml";

// Google Gemini API — OpenAI-compatible endpoint
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-3.5-flash";

// Load .env manually (no dotenv dependency)
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY not set.");
  console.error("");
  console.error("To get a free API key:");
  console.error("  1. Go to https://aistudio.google.com/apikey");
  console.error("  2. Sign in with your Google account");
  console.error('  3. Click "Create API key"');
  console.error("  4. Add to .env:  GEMINI_API_KEY=AIza...your_key_here");
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("❌ config.yaml not found!");
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

async function main() {
  console.log("\n🎵 Taste Profile Generator (Google Gemini — Free)\n");

  const config = loadConfig();
  const token = loadToken();

  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });
  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);

  // Refresh token
  const refreshData = await spotifyApi.refreshAccessToken();
  spotifyApi.setAccessToken(refreshData.body.access_token);

  // Collect top artists and tracks across all time ranges
  const artistCounts = {};
  const trackSamples = [];

  for (const range of ["short_term", "medium_term", "long_term"]) {
    console.log(`📊 Fetching top tracks (${range})...`);
    const data = await spotifyApi.getMyTopTracks({
      limit: 50,
      time_range: range,
    });

    for (const track of data.body.items) {
      trackSamples.push({
        name: track.name,
        artists: track.artists.map((a) => a.name),
      });
      for (const artist of track.artists) {
        artistCounts[artist.name] = (artistCounts[artist.name] || 0) + 1;
      }
    }
  }

  // Also get top artists directly
  for (const range of ["short_term", "medium_term", "long_term"]) {
    console.log(`📊 Fetching top artists (${range})...`);
    const data = await spotifyApi.getMyTopArtists({
      limit: 50,
      time_range: range,
    });
    for (const artist of data.body.items) {
      artistCounts[artist.name] = (artistCounts[artist.name] || 0) + 2;
    }
  }

  // Sort artists by frequency
  const topArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name]) => name);

  // Deduplicate track samples
  const seen = new Set();
  const uniqueTracks = [];
  for (const t of trackSamples) {
    const key = `${t.name}|${t.artists[0]}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTracks.push(t);
    }
  }

  console.log(`\n🎤 Top artists: ${topArtists.slice(0, 15).join(", ")}...`);
  console.log(`🎵 Unique tracks analyzed: ${uniqueTracks.length}`);

  // Build the LLM prompt
  const artistList = topArtists.join(", ");
  const trackList = uniqueTracks
    .slice(0, 50)
    .map((t) => `${t.name} — ${t.artists.join(", ")}`)
    .join("\n");

  const llmPrompt = `Based on this Spotify listening data, generate a list of 5-8 genre/style tags that best describe this user's music taste. These tags will be used as Spotify search queries (e.g., "genre:pop") to discover new music matching their taste.

Top artists (ranked by listening frequency):
${artistList}

Sample tracks:
${trackList}

Requirements:
- Return ONLY a YAML array of strings, nothing else
- Use genres that work well as Spotify search queries
- Be specific enough to be useful (e.g., "synth pop" not just "pop")
- Cover the breadth of their taste, not just the most common genre
- Use lowercase

Example output format:
- synth pop
- indie rock
- electronic
- alt pop
- dance pop`;

  console.log("\n🤖 Asking Google Gemini to analyze your taste...\n");

  // Call Google Gemini API (OpenAI-compatible endpoint)
  const response = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GEMINI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages: [
        {
          role: "user",
          content: llmPrompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`❌ Gemini API error: ${response.status} ${errBody}`);
    if (response.status === 400 || response.status === 403) {
      console.error(
        "\nCheck that your GEMINI_API_KEY is valid: https://aistudio.google.com/apikey"
      );
    }
    process.exit(1);
  }

  const result = await response.json();
  const llmOutput = result.choices[0].message.content.trim();

  console.log("LLM suggested genres:");
  console.log(llmOutput);

  // Parse the YAML array from LLM output
  // Strip markdown code fences if present
  let cleanOutput = llmOutput;
  cleanOutput = cleanOutput.replace(/```ya?ml?\n?/gi, "").replace(/```\n?/g, "");

  let genres;
  try {
    genres = yaml.load(cleanOutput);
  } catch {
    // Fallback: parse line by line
    genres = cleanOutput
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  if (!Array.isArray(genres) || genres.length === 0) {
    console.error("❌ Failed to parse genres from LLM output");
    process.exit(1);
  }

  console.log(`\n✅ Detected ${genres.length} genres:`);
  genres.forEach((g) => console.log(`   - ${g}`));

  // Update config.yaml
  const rawConfig = fs.readFileSync(CONFIG_FILE, "utf8");

  let updatedConfig;
  // Replace existing genres block or add one
  const genresYaml = genres.map((g) => `    - ${g}`).join("\n");

  if (rawConfig.match(/^  genres:\s*$/m)) {
    // Replace existing genres array
    updatedConfig = rawConfig.replace(
      /^  genres:\s*\n(    - .*\n)*/m,
      `  genres:\n${genresYaml}\n`
    );
  } else if (rawConfig.match(/^  # genres:/m)) {
    // Replace commented-out genres block
    updatedConfig = rawConfig.replace(
      /^  # genres:\s*\n(  #\s+- .*\n)*/m,
      `  genres:\n${genresYaml}\n`
    );
  } else {
    // Add after top_tracks block
    updatedConfig = rawConfig.replace(
      /(top_tracks:.*\n(?:    .*\n)*)/,
      `$1\n  genres:\n${genresYaml}\n`
    );
  }

  fs.writeFileSync(CONFIG_FILE, updatedConfig);
  console.log("\n💾 Updated config.yaml with new genres");
  console.log("\nRun 'npm test' to preview your updated playlist.\n");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
