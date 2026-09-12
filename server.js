#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const yaml = require("js-yaml");
const express = require("express");
const { loadConfig, getAuthenticatedApi, runBuild } = require("./index");

const CONFIG_FILE = "config.yaml";
const PORT = Number(process.env.PORT) || 3000;
const execFileAsync = promisify(execFile);
const nodeLog = [];
const MAX_LOG_LINES = 300;

function recordLog(args) {
  const line = args.map((arg) => {
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(" ");
  nodeLog.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (nodeLog.length > MAX_LOG_LINES) nodeLog.splice(0, nodeLog.length - MAX_LOG_LINES);
}

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
for (const level of Object.keys(originalConsole)) {
  console[level] = (...args) => {
    recordLog(args);
    originalConsole[level](...args);
  };
}

function parseShowId(input) {
  const s = String(input || "").trim();
  const fromUrl = s.match(/(?:show\/|spotify:show:)([A-Za-z0-9]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9]+$/.test(s) && s.length >= 10) return s;
  throw new Error(`Invalid show ID or URL: ${input}`);
}

function publicConfig(config) {
  return {
    podcasts: (config.podcasts || []).map((p) => ({
      name: p.name || "",
      id: p.id || "",
      episodes: p.episodes || 1,
      mode: p.mode || "newest",
      position: p.position || "",
      scan_limit: p.scan_limit || 50,
    })),
    genres: config.music?.genres || [],
    total_songs: config.music?.total_songs ?? 15,
    mix_pattern: config.mix_pattern || "PMMM",
  };
}

function patchConfig(config, body) {
  const next = { ...config, music: { ...(config.music || {}) } };
  if (body.podcasts) {
    next.podcasts = body.podcasts.map((p) => {
      const podcast = {
        name: String(p.name || "").trim() || "Podcast",
        id: parseShowId(p.id || p.url),
        episodes: Math.max(1, Number(p.episodes) || 1),
        mode: ["newest_unplayed", "oldest_unplayed"].includes(p.mode) ? p.mode : "newest",
      };
      if (p.position === "first") podcast.position = "first";
      if (["newest_unplayed", "oldest_unplayed"].includes(podcast.mode)) {
        podcast.scan_limit = Math.max(1, Number(p.scan_limit) || 50);
      }
      return podcast;
    });
  }
  if (body.genres !== undefined) {
    next.music.genres = (body.genres || []).map((g) => String(g).trim()).filter(Boolean);
    if (next.music.genres.length === 0) delete next.music.genres;
  }
  if (body.total_songs !== undefined) {
    next.music.total_songs = Math.max(1, Number(body.total_songs) || 15);
  }
  if (body.mix_pattern !== undefined) {
    const pattern = String(body.mix_pattern).replace(/[^PMpm]/g, "").toUpperCase();
    next.mix_pattern = pattern || "PMMM";
  }
  return next;
}

function pickImage(images) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= 64) || sorted[sorted.length - 1]).url;
}

function mapPlaylistItem(entry) {
  const item = entry.item || entry.track;
  if (!item) return null;
  if (item.type === "track") {
    return {
      type: "track",
      name: item.name,
      subtitle: item.artists?.map((a) => a.name).join(", ") || "Unknown",
      image: pickImage(item.album?.images),
      uri: item.uri,
    };
  }
  if (item.type === "episode") {
    return {
      type: "episode",
      name: item.name,
      subtitle: item.show?.name || "Podcast",
      image: pickImage(item.images) || pickImage(item.show?.images),
      uri: item.uri,
    };
  }
  return null;
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/log", (_req, res) => {
  res.json({ lines: nodeLog });
});

app.get("/api/config", (_req, res) => {
  try {
    res.json(publicConfig(loadConfig()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/config", (req, res) => {
  try {
    const next = patchConfig(loadConfig(), req.body || {});
    fs.writeFileSync(CONFIG_FILE, yaml.dump(next, { lineWidth: 120, noRefs: true }));
    res.json(publicConfig(next));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/playlist", async (_req, res) => {
  try {
    const { spotifyApi, config } = await getAuthenticatedApi();
    if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
      throw new Error("Please set your playlist_id in config.yaml");
    }
    const accessToken = spotifyApi.getAccessToken();
    const url = `https://api.spotify.com/v1/playlists/${config.playlist_id}/items?limit=100`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!apiRes.ok) {
      throw new Error(`Failed to read playlist: ${apiRes.status} ${await apiRes.text()}`);
    }
    const data = await apiRes.json();
    const items = (data.items || []).map(mapPlaylistItem).filter(Boolean);
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let refreshRunning = false;

app.post("/api/refresh", async (_req, res) => {
  if (refreshRunning) {
    return res.status(409).json({ error: "A refresh is already running" });
  }
  refreshRunning = true;
  try {
    const result = await runBuild({ podcastOnly: false, dryRun: !!_req.body?.dryRun });
    res.json({ ok: true, last_updated: result.last_updated, skipped: !!result.skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    refreshRunning = false;
  }
});

let geminiRunning = false;

app.post("/api/gemini-refresh", async (_req, res) => {
  if (geminiRunning) {
    return res.status(409).json({ error: "A Gemini refresh is already running" });
  }
  geminiRunning = true;
  try {
    const result = await execFileAsync(process.execPath, [path.join(__dirname, "taste-profile-google.js")], {
      cwd: __dirname,
      maxBuffer: 1024 * 1024,
    });
    result.stdout.split("\n").filter(Boolean).forEach((line) => recordLog([line]));
    res.json({ ok: true, output: result.stdout });
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    if (output) output.split("\n").forEach((line) => recordLog([line]));
    res.status(500).json({ error: output || err.message });
  } finally {
    geminiRunning = false;
  }
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Daily Drive GUI: http://127.0.0.1:${PORT}`);
    console.log("LAN-only tool — no login. Do not expose this to the public internet.");
  });
}

module.exports = { parseShowId, patchConfig, publicConfig, pickImage, mapPlaylistItem };
