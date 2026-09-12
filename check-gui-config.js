#!/usr/bin/env node
const assert = require("assert");
const { parseShowId, patchConfig, publicConfig, pickImage, mapPlaylistItem } = require("./server");

assert.strictEqual(parseShowId("6z4NLXyHPga1UmSJsPK7G1"), "6z4NLXyHPga1UmSJsPK7G1");
assert.strictEqual(
  parseShowId("https://open.spotify.com/show/6z4NLXyHPga1UmSJsPK7G1?si=abc"),
  "6z4NLXyHPga1UmSJsPK7G1"
);
assert.strictEqual(parseShowId("spotify:show:6BRSvIBNQnB68GuoXJRCnQ"), "6BRSvIBNQnB68GuoXJRCnQ");
assert.throws(() => parseShowId("not a show"), /Invalid show ID/);

const base = {
  spotify: { client_id: "secret-id", client_secret: "secret" },
  playlist_id: "keep-me",
  schedule: { times: ["04:00"] },
  music: { top_tracks: { enabled: true }, playlists: [{ name: "X", id: "abc" }], total_songs: 19 },
  podcasts: [],
  mix_pattern: "PMMM",
};

const patched = patchConfig(base, {
  podcasts: [
    {
      name: "Freakonomics",
      id: "https://open.spotify.com/show/6z4NLXyHPga1UmSJsPK7G1",
      episodes: 1,
      mode: "oldest_unplayed",
      position: "first",
      scan_limit: 40,
    },
  ],
  genres: [" indie pop ", "", "edm"],
  total_songs: 12,
  mix_pattern: "pm mm",
});

assert.strictEqual(patched.spotify.client_secret, "secret");
assert.strictEqual(patched.playlist_id, "keep-me");
assert.deepStrictEqual(patched.schedule, { times: ["04:00"] });
assert.deepStrictEqual(patched.music.top_tracks, { enabled: true });
assert.deepStrictEqual(patched.music.playlists, [{ name: "X", id: "abc" }]);
assert.strictEqual(patched.podcasts[0].id, "6z4NLXyHPga1UmSJsPK7G1");
assert.strictEqual(patched.podcasts[0].position, "first");
assert.strictEqual(patched.podcasts[0].mode, "oldest_unplayed");
assert.strictEqual(patched.podcasts[0].scan_limit, 40);
assert.strictEqual(
  patchConfig(base, { podcasts: [{ name: "Show", id: "6z4NLXyHPga1UmSJsPK7G1", mode: "newest_unplayed" }] }).podcasts[0].mode,
  "newest_unplayed"
);
assert.deepStrictEqual(patched.music.genres, ["indie pop", "edm"]);
assert.strictEqual(patched.music.total_songs, 12);
assert.strictEqual(patched.mix_pattern, "PMMM");
assert.strictEqual(patchConfig(base, { mix_pattern: "pmmmm" }).mix_pattern, "PMMMM");

const pub = publicConfig(patched);
assert.ok(!("spotify" in pub));
assert.ok(!JSON.stringify(pub).includes("secret"));

assert.strictEqual(
  pickImage([{ url: "small", width: 32 }, { url: "ok", width: 64 }, { url: "big", width: 300 }]),
  "ok"
);

const mapped = mapPlaylistItem({
  item: {
    type: "track",
    name: "Song",
    uri: "spotify:track:1",
    artists: [{ name: "A" }],
    album: { images: [{ url: "cover", width: 64 }] },
  },
});
assert.deepStrictEqual(mapped, {
  type: "track",
  name: "Song",
  subtitle: "A",
  image: "cover",
  uri: "spotify:track:1",
});

const ep = mapPlaylistItem({
  item: {
    type: "episode",
    name: "Ep",
    uri: "spotify:episode:1",
    images: [],
    show: { name: "Show", images: [{ url: "show-art", width: 64 }] },
  },
});
assert.strictEqual(ep.image, "show-art");
assert.strictEqual(ep.subtitle, "Show");

console.log("check-gui-config: ok");
