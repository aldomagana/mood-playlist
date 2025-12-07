const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const querystring = require('querystring');

app.use(cors());
app.use(express.json());

// Helper to read environment variables with optional fallback names and remove surrounding quotes
function getEnv(primary, fallback) {
  let v = process.env[primary];
  if (!v && fallback) v = process.env[fallback];
  if (!v) return undefined;
  // remove surrounding double quotes if present
  return v.replace(/^"(.*)"$/, '$1');
}

const CLIENT_ID = getEnv('CLIENT_ID', 'SPOTIFY_CLIENT_ID');
const CLIENT_SECRET = getEnv('CLIENT_SECRET', 'SPOTIFY_CLIENT_SECRET');
const REDIRECT_URI = getEnv('REDIRECT_URI', 'REDIRECT_URI');
const FRONTEND_URI = getEnv('FRONTEND_URI', 'FRONTEND_URI') || 'http://localhost:5173';
const PORT = getEnv('PORT', 'PORT') || 5001;

// (duplicate removed) SKIP_RECOMMENDATIONS already declared above

// QUICK FIX: set to true to skip Spotify /recommendations entirely and use the search/playlist fallback.
// This short-circuits repeated 404s from recommendations and should restore functionality quickly.
const SKIP_RECOMMENDATIONS = true;

// 1️⃣ LOGIN ROUTE — user clicks login → Spotify's auth page
app.get('/login', (req, res) => {
  // Request scopes required to read user profile and create playlists
  const scope = 'user-read-private user-read-email playlist-modify-private playlist-modify-public';

  const authUrl =
    'https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: scope,
      redirect_uri: REDIRECT_URI,
    });

  console.log("Redirecting user to:", authUrl);

  res.redirect(authUrl);
});

// 2️⃣ CALLBACK ROUTE — Spotify redirects here with `code`
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  console.log("Callback hit. Code:", code);

  if (!code) {
    console.log("No code received.");
    return res.status(400).send("No code returned from Spotify");
  }

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log("Token Success:", tokenRes.data);

    // Redirect to frontend app with tokens as query params so the client can store them
  const frontend = FRONTEND_URI || 'http://localhost:5173';
    const redirectTo = frontend +
      '?' +
      querystring.stringify({
        access_token: tokenRes.data.access_token,
        refresh_token: tokenRes.data.refresh_token,
        expires_in: tokenRes.data.expires_in,
      });

    console.log("Redirecting to frontend:", redirectTo);
    res.redirect(redirectTo);
  } catch (err) {
    console.error("Error exchanging code for token:", err.response?.data || err);
    res.status(500).send("Token exchange failed");
  }
});

// 3️⃣ GENERATE PLAYLIST ROUTE
app.post('/generate', async (req, res) => {
  console.log("Generate route hit. Body:", req.body);

  const mood = req.body && req.body.mood;
  // sanitize access token: accept as string, remove whitespace/newlines which sometimes appear when tokens
  // are copied/pasted or transmitted incorrectly from the frontend
  let access_token = (req.body && req.body.access_token) || '';
  if (typeof access_token !== 'string') access_token = String(access_token || '');
  // remove any whitespace/newlines
  access_token = access_token.replace(/\s+/g, '').trim();

  if (!mood || !access_token) {
    console.log("Missing data or invalid token. Mood:", mood, "tokenPresent:", !!access_token);
    return res.status(400).json({ error: "Mood and access token required" });
  }

  console.log('Using access token (masked):', access_token ? `${access_token.slice(0,8)}...${access_token.slice(-8)}` : 'NONE');

  const genreMap = {
    happy: "pop",
    sad: "acoustic",
    angry: "metal",
    chill: "lofi",
    party: "dance",
    focus: "ambient",
  };

  const genre = genreMap[mood] || "pop";

  try {
    // In-memory recent track store (userId:mood -> array of recent URIs)
    // Note: this is ephemeral and will reset when the server restarts. For persistence, replace with a DB.
    if (!global.recentTracksStore) global.recentTracksStore = new Map();

    // 0) Get current user's id early (we need it for the recent-store key)
    const meResEarly = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const userIdEarly = meResEarly.data.id;

    // helper to key recent store
    const recentKey = `${userIdEarly}:${mood}`;
  // quick-repeat detection: if user requests same mood within this ms window, treat as quick repeat
  if (!global.recentTimestamps) global.recentTimestamps = new Map();
  const nowTs = Date.now();
  const lastTs = global.recentTimestamps.get(recentKey) || 0;
  const QUICK_REPEAT_MS = 2000; // 2 seconds
  const isQuickRepeat = (nowTs - lastTs) < QUICK_REPEAT_MS;
  if (isQuickRepeat) console.log(`Quick repeat detected for ${recentKey} (${nowTs - lastTs}ms)`);

    // Validate the chosen genre against Spotify's available genre seeds
    let availableGenres = [];
    try {
      const seedsRes = await axios.get('https://api.spotify.com/v1/recommendations/available-genre-seeds', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      availableGenres = seedsRes.data.genres || [];
    } catch (seedErr) {
      console.warn('Could not retrieve available genre seeds:', seedErr.response?.data || seedErr.message || seedErr);
      // continue — we'll attempt recommendations and handle errors below
    }

    let chosenGenre = genre;
    if (availableGenres.length > 0) {
      if (!availableGenres.includes(genre)) {
        // try to find a partial match (e.g. 'ambient' -> 'ambient' or 'lo-fi' -> 'lofi')
        let partial = availableGenres.find(g => g.toLowerCase().includes(genre.toLowerCase()) || genre.toLowerCase().includes(g.toLowerCase()));
        if (!partial) {
          const firstWord = genre.split(/[^a-zA-Z0-9]+/)[0];
          partial = availableGenres.find(g => g.toLowerCase().includes(firstWord.toLowerCase()));
        }

        if (partial) {
          console.warn(`Requested genre '${genre}' not in seeds; using partial match '${partial}'`);
          chosenGenre = partial;
        } else {
          console.warn(`Requested genre '${genre}' not in available seeds. Falling back to '${availableGenres[0]}'`);
          chosenGenre = availableGenres[0];
        }
      }
    }
    console.log('Using seed genre:', chosenGenre);
  // 1) Try to get recommendations with some randomness so repeated calls produce varied playlists
    let tracks = [];

    // helper: random float in [min, max]
    const randFloat = (min, max) => Math.random() * (max - min) + min;
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // Build recommendation params with randomized audio feature targets
    const recParams = {
      limit: randInt(12, 25), // vary playlist size
      market: 'US'
    };

    // Randomly choose whether to include a seed_artist/seed_track in addition to seed_genres
    const includeSeedArtist = Math.random() < 0.6; // higher chance to include artist
    const includeSeedTrack = !includeSeedArtist && Math.random() < 0.6;

    // Choose 1-2 seed genres from availableGenres if possible, otherwise use chosenGenre
    if (availableGenres.length > 0) {
      // try to prioritize chosenGenre if present
      const pool = [...availableGenres];
      const picked = [];
      // If chosenGenre is in pool, keep it as a candidate
      if (pool.includes(chosenGenre)) {
        picked.push(chosenGenre);
        // remove it from pool so we can pick another different genre
        const idx = pool.indexOf(chosenGenre);
        if (idx !== -1) pool.splice(idx, 1);
      }
      while (picked.length < 2 && pool.length > 0 && Math.random() < 0.7) {
        const i = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(i, 1)[0]);
      }
      if (picked.length > 0) recParams.seed_genres = picked.join(',');
    } else if (chosenGenre) {
      recParams.seed_genres = chosenGenre;
    }

    // Add random target audio features to nudge the recommendations (numbers, not strings)
    // valence: 0.0 (sad) - 1.0 (happy), energy: 0.0 - 1.0, tempo: 60-140
    recParams.target_valence = Number(randFloat(0.15, 0.95).toFixed(2));
    recParams.target_energy = Number(randFloat(0.15, 0.98).toFixed(2));
    recParams.target_tempo = randInt(60, 150);

    try {
      // Optionally attempt to fetch user's top artists to use as seed_artists
      if (includeSeedArtist) {
        try {
          const topArtistsRes = await axios.get('https://api.spotify.com/v1/me/top/artists', {
            headers: { Authorization: `Bearer ${access_token}` },
            params: { limit: 5 }
          });
          const topArtists = (topArtistsRes.data.items || []).map(a => a.id);
          if (topArtists.length > 0) {
            // pick 1 or 2 random artists
            const chosen = [];
            while (chosen.length < Math.min(2, topArtists.length)) {
              const pick = topArtists[Math.floor(Math.random() * topArtists.length)];
              if (!chosen.includes(pick)) chosen.push(pick);
            }
            recParams.seed_artists = chosen.join(',');
          }
        } catch (topErr) {
          console.warn('Could not fetch top artists for seed_artists:', topErr.response?.data || topErr.message || topErr);
        }
      }

      // If seed_track requested, attempt to grab a random track from search for chosenGenre
      if (includeSeedTrack) {
        try {
          const searchTrackRes = await axios.get('https://api.spotify.com/v1/search', {
            headers: { Authorization: `Bearer ${access_token}` },
            params: { q: chosenGenre || genre, type: 'track', limit: 20 }
          });
          const items = (searchTrackRes.data.tracks && searchTrackRes.data.tracks.items) || [];
          if (items.length > 0) {
            const pick = items[Math.floor(Math.random() * items.length)];
            recParams.seed_tracks = pick.id;
          }
        } catch (stErr) {
          console.warn('Could not fetch seed track for seed_tracks:', stErr.response?.data || stErr.message || stErr);
        }
      }

  console.log('Recommendation params:', recParams);

      // Try multiple recommendation variants to reduce 404s from strict param combos
      let originalRecTracks = [];
      const recVariants = [];
      // If SKIP_RECOMMENDATIONS is set, we'll force the code to use search/playlist-scrape fallback
      // This helps when the Spotify recommendations endpoint is returning 4xx/404 frequently.
      let forcedToFallback = false;
      if (SKIP_RECOMMENDATIONS) {
        console.log('SKIP_RECOMMENDATIONS is true — skipping Spotify recommendations and using search fallback');
        // Throw to jump to the existing catch block that runs the search/playlist scraping fallback.
        // This ensures we don't partially run recommendation attempts and reliably use the fallback path.
        throw new Error('FORCE_SEARCH_FALLBACK');
      }
      // primary
      recVariants.push({ ...recParams });
      // without seed_tracks
      if (recParams.seed_tracks) recVariants.push({ ...recParams, seed_tracks: undefined });
      // without seed_artists
      if (recParams.seed_artists) recVariants.push({ ...recParams, seed_artists: undefined });
      // only genres
      if (recParams.seed_genres) recVariants.push({ limit: recParams.limit, market: recParams.market, seed_genres: recParams.seed_genres });
      // looser targets
      recVariants.push({ ...recParams, target_valence: Number(randFloat(0.2, 0.8).toFixed(2)), target_energy: Number(randFloat(0.2, 0.9).toFixed(2)), target_tempo: randInt(60, 150) });

      let recSuccess = false;
      for (let i = 0; i < recVariants.length; i++) {
        const attemptParams = { ...recVariants[i] };
        // If we've decided to force the fallback, break out early
        if (forcedToFallback) {
          console.log('Forced fallback enabled — not attempting recommendations');
          break;
        }
        // remove undefined keys
        Object.keys(attemptParams).forEach(k => attemptParams[k] === undefined && delete attemptParams[k]);
        try {
          console.log('Attempting recommendations variant', i + 1, attemptParams);
          const recRes = await axios.get('https://api.spotify.com/v1/recommendations', { headers: { Authorization: `Bearer ${access_token}` }, params: attemptParams });
          originalRecTracks = recRes.data.tracks || [];
          if (originalRecTracks.length > 0) {
            console.log('Spotify recommendations success (variant', i + 1, ')');
            recSuccess = true;
            break;
          }
        } catch (e) {
          const status = e.response?.status;
          console.warn(`Recommendations variant ${i + 1} failed:`, status || e.message);
          // If it's a client error (4xx), further attempts are unlikely to succeed — fall back to search
          if (status && status >= 400 && status < 500) {
            console.warn('Client error from recommendations API (4xx) — aborting further recommendation attempts and falling back to search');
            break;
          }
          // otherwise try next variant
        }
      }

      // If all initial variants failed, try some additional tolerant attempts before falling back to search
      if (!recSuccess) {
        console.warn('All initial recommendation variants failed or returned no tracks; trying tolerant attempts (no market, only genres)...');
        try {
          // Attempt without market (some tokens/regions may not accept explicit market param)
          const altNoMarket = { ...recParams };
          delete altNoMarket.market;
          Object.keys(altNoMarket).forEach(k => altNoMarket[k] === undefined && delete altNoMarket[k]);
          console.log('Attempting recommendations without market:', altNoMarket);
          const recResNoMarket = await axios.get('https://api.spotify.com/v1/recommendations', { headers: { Authorization: `Bearer ${access_token}` }, params: altNoMarket });
          originalRecTracks = recResNoMarket.data.tracks || [];
          if (originalRecTracks.length > 0) {
            console.log('Spotify recommendations success (no-market fallback)');
            recSuccess = true;
          }
        } catch (noMErr) {
          console.warn('No-market recommendation attempt failed:', noMErr.response?.status || noMErr.message);
        }
      }

      if (!recSuccess) {
        try {
          // Try with only seed_genres and minimal params
          if (recParams.seed_genres) {
            const onlyGenres = { limit: recParams.limit || 20, seed_genres: recParams.seed_genres };
            console.log('Attempting recommendations with only seed_genres:', onlyGenres);
            const recResGenres = await axios.get('https://api.spotify.com/v1/recommendations', { headers: { Authorization: `Bearer ${access_token}` }, params: onlyGenres });
            originalRecTracks = recResGenres.data.tracks || [];
            if (originalRecTracks.length > 0) {
              console.log('Spotify recommendations success (only-genres fallback)');
              recSuccess = true;
            }
          }
        } catch (gErr) {
          console.warn('Only-genres recommendation attempt failed:', gErr.response?.status || gErr.message);
        }
      }

      if (!recSuccess) console.warn('All recommendation attempts failed or returned no tracks; falling back to search');

      // Additional tolerant attempts: strip target_* params, try a very small limit, and try fetching full track objects if ids present
      if (!recSuccess) {
        // 1) Strip target_* params and retry
        try {
          const stripped = { ...recParams };
          delete stripped.target_valence;
          delete stripped.target_energy;
          delete stripped.target_tempo;
          Object.keys(stripped).forEach(k => stripped[k] === undefined && delete stripped[k]);
          console.log('Attempting recommendations stripped of target_* params:', stripped);
          const recResStripped = await axios.get('https://api.spotify.com/v1/recommendations', { headers: { Authorization: `Bearer ${access_token}` }, params: stripped });
          originalRecTracks = recResStripped.data.tracks || [];
          if (originalRecTracks.length > 0) {
            console.log('Spotify recommendations success (stripped targets)');
            recSuccess = true;
          }
        } catch (stErr) {
          console.warn('Stripped-targets recommendation attempt failed:', stErr.response?.status || stErr.message);
        }
      }

      if (!recSuccess) {
        // 2) Try very small limit in case parameter combination fails for larger sizes
        try {
          const small = { seed_genres: recParams.seed_genres, limit: 5 };
          console.log('Attempting recommendations with small limit:', small);
          const recResSmall = await axios.get('https://api.spotify.com/v1/recommendations', { headers: { Authorization: `Bearer ${access_token}` }, params: small });
          originalRecTracks = recResSmall.data.tracks || [];
          if (originalRecTracks.length > 0) {
            console.log('Spotify recommendations success (small limit)');
            recSuccess = true;
          }
        } catch (sErr) {
          console.warn('Small-limit recommendation attempt failed:', sErr.response?.status || sErr.message);
        }
      }

      if (!recSuccess && Array.isArray(originalRecTracks) && originalRecTracks.length > 0) {
        // 3) If we have lightweight track objects (or only ids), try fetching full track details
        try {
          const ids = originalRecTracks.map(t => t.id).filter(Boolean);
          if (ids.length > 0) {
            console.log('Fetching full track details for', ids.length, 'ids');
            const detailed = [];
            for (let i = 0; i < ids.length; i += 50) {
              const chunk = ids.slice(i, i + 50);
              try {
                const tr = await axios.get('https://api.spotify.com/v1/tracks', { headers: { Authorization: `Bearer ${access_token}` }, params: { ids: chunk.join(',') } });
                (tr.data && tr.data.tracks || []).forEach(t => t && detailed.push(t));
              } catch (tdErr) {
                console.warn('Fetching track details chunk failed:', tdErr.response?.status || tdErr.message);
              }
            }
            if (detailed.length > 0) {
              originalRecTracks = detailed;
              recSuccess = true;
              console.log('Successfully fetched detailed track objects from ids');
            }
          }
        } catch (detErr) {
          console.warn('Error when fetching detailed track info:', detErr.response?.status || detErr.message);
        }
      }
      // Filter out recently used URIs for this user/mood (skip if quick repeat)
      try {
        const recent = isQuickRepeat ? [] : (global.recentTracksStore.get(recentKey) || []);
        if (recent.length > 0) {
          tracks = originalRecTracks.filter(t => !recent.includes(t.uri));
        } else {
          tracks = [...originalRecTracks];
        }
      } catch (ferr) {
        console.warn('Could not filter recent tracks:', ferr);
        tracks = [...originalRecTracks];
      }

      // If filtering removed all candidates, relax the filter: take some original tracks
      if ((!tracks || tracks.length === 0) && originalRecTracks.length > 0) {
        console.warn('All recommended tracks were filtered as recent — relaxing filter to include some recent tracks');
        // pick a subset from originalRecTracks to fill the playlist (mix of old and new)
        // take every other track to increase variety while allowing some recent ones
        tracks = originalRecTracks.filter((t, idx) => idx % 2 === 0).slice(0, recParams.limit || 20);
      }
      // Shuffle tracks so order differs between calls even with same items
      const shuffle = (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      };
      shuffle(tracks);
      // Ensure we only keep up to recParams.limit
      tracks = tracks.slice(0, recParams.limit || 20);

      // Diversify tracks by artist: pick at most one track per artist (configurable)
      const diversify = (tracksList, limit, maxPerArtist = 1) => {
        const byArtist = new Map();
        tracksList.forEach(t => {
          const aid = (t.artists && t.artists[0] && t.artists[0].id) || (t.artists && t.artists[0] && t.artists[0].name) || 'unknown';
          if (!byArtist.has(aid)) byArtist.set(aid, []);
          byArtist.get(aid).push(t);
        });

        const artistIds = Array.from(byArtist.keys());
        shuffle(artistIds);

        const result = [];
        // round-robin pick up to maxPerArtist from different artists to maximize diversity
        while (result.length < limit && artistIds.length > 0) {
          for (let i = 0; i < artistIds.length && result.length < limit; i++) {
            const aid = artistIds[i];
            const bucket = byArtist.get(aid);
            if (!bucket || bucket.length === 0) continue;
            // pick a random track from this artist's bucket
            const pickIndex = Math.floor(Math.random() * bucket.length);
            const pick = bucket.splice(pickIndex, 1)[0];
            result.push(pick);
            // if artist exhausted, remove it from rotation
            if (bucket.length === 0) {
              artistIds.splice(i, 1);
              i--;
            }
          }
        }

        // if we still need tracks, fill from remaining tracksList (dedup by uri)
        const seenUris = new Set(result.map(r => r.uri));
        for (const t of tracksList) {
          if (result.length >= limit) break;
          if (!seenUris.has(t.uri)) {
            result.push(t);
            seenUris.add(t.uri);
          }
        }
        return result.slice(0, limit);
      };

      tracks = diversify(tracks, recParams.limit || 20, 1);

      // after diversifying, store the URIs as recent for this user/mood (keep last 100)
      try {
        if (!isQuickRepeat) {
          const urisToStore = tracks.map(t => t.uri).filter(Boolean);
          const prev = global.recentTracksStore.get(recentKey) || [];
          const merged = [...urisToStore, ...prev].slice(0, 100);
          global.recentTracksStore.set(recentKey, merged);
        } else {
          console.log('Skipping storing recent tracks due to quick repeat');
        }
        // update last timestamp regardless so we track activity
        global.recentTimestamps.set(recentKey, nowTs);
      } catch (serr) {
        console.warn('Could not store recent tracks:', serr);
      }
    } catch (recErr) {
      console.warn('Recommendations endpoint failed, attempting search fallback:', recErr.response?.status, recErr.response?.data || recErr.message);
      console.warn('Recommendation request headers:', recErr.config?.headers);
      // fallback: use multiple search queries to assemble a larger candidate pool before filtering
      try {
        const queries = [chosenGenre, genre, mood, `${chosenGenre} remix`, `${mood} playlist`].filter(Boolean);
        const candidateMap = new Map();
        for (const q of queries) {
          try {
            const searchRes = await axios.get('https://api.spotify.com/v1/search', {
              headers: { Authorization: `Bearer ${access_token}` },
              params: { q, type: 'track', limit: 40, market: 'US' }
            });
            const items = (searchRes.data.tracks && searchRes.data.tracks.items) || [];
            for (const it of items) {
              if (it && it.uri) candidateMap.set(it.uri, it);
            }
          } catch (qe) {
            console.warn('Search query failed for', q, qe.response?.status || qe.message);
          }
        }
        let originalSearchTracks = Array.from(candidateMap.values());
        console.log('Search fallback collected', originalSearchTracks.length, 'unique tracks');
        // If we didn't collect many tracks, try searching playlists and extracting their top tracks
        if (originalSearchTracks.length < 20) {
          console.log('Search fallback: few tracks collected, searching playlists for more candidates...');
          try {
            const playlistQueries = [chosenGenre, `${mood} playlist`, `${chosenGenre} playlist`, `${mood} mix`].filter(Boolean);
            for (const pq of playlistQueries) {
              try {
                const plistRes = await axios.get('https://api.spotify.com/v1/search', {
                  headers: { Authorization: `Bearer ${access_token}` },
                  params: { q: pq, type: 'playlist', limit: 10, market: 'US' }
                });
                const playItems = (plistRes.data.playlists && plistRes.data.playlists.items) || [];
                for (const p of playItems) {
                  // fetch playlist tracks (first 50)
                  try {
                    const tracksRes = await axios.get(`https://api.spotify.com/v1/playlists/${p.id}/tracks`, {
                      headers: { Authorization: `Bearer ${access_token}` },
                      params: { limit: 50 }
                    });
                    const pts = (tracksRes.data.items || []).map(it => it.track).filter(Boolean);
                    for (const pt of pts) {
                      if (pt && pt.uri) candidateMap.set(pt.uri, pt);
                    }
                  } catch (ptErr) {
                    console.warn('Could not fetch playlist tracks for', p.id, ptErr.response?.status || ptErr.message);
                  }
                }
              } catch (pqErr) {
                console.warn('Playlist search failed for', pq, pqErr.response?.status || pqErr.message);
              }
            }
            originalSearchTracks = Array.from(candidateMap.values());
            console.log('After playlist scraping, collected', originalSearchTracks.length, 'unique tracks');
          } catch (plErr) {
            console.warn('Playlist scraping fallback failed:', plErr.response?.status || plErr.message || plErr);
          }
        }
        tracks = [...originalSearchTracks];
        // filter recent
        try {
          const recent = isQuickRepeat ? [] : (global.recentTracksStore.get(recentKey) || []);
          if (recent.length > 0) tracks = tracks.filter(t => !recent.includes(t.uri));
        } catch (ferr) {
          console.warn('Could not filter recent tracks (search):', ferr);
        }
        // If filtering removed all candidates, relax filter and pick a subset of originalSearchTracks
        if ((!tracks || tracks.length === 0) && originalSearchTracks.length > 0) {
          console.warn('All search results were filtered as recent — relaxing search filter to include some recent tracks');
          tracks = originalSearchTracks.filter((t, idx) => idx % 2 === 0).slice(0, recParams.limit || 20);
        }
        // shuffle and limit
        const shuffle = (arr) => {
          for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
        };
        shuffle(tracks);
        tracks = tracks.slice(0, recParams.limit || 20);
        // diversify to reduce repeated artists
        const diversify = (tracksList, limit, maxPerArtist = 1) => {
          const byArtist = new Map();
          tracksList.forEach(t => {
            const aid = (t.artists && t.artists[0] && t.artists[0].id) || (t.artists && t.artists[0] && t.artists[0].name) || 'unknown';
            if (!byArtist.has(aid)) byArtist.set(aid, []);
            byArtist.get(aid).push(t);
          });

          const artistIds = Array.from(byArtist.keys());
          shuffle(artistIds);

          const result = [];
          while (result.length < limit && artistIds.length > 0) {
            for (let i = 0; i < artistIds.length && result.length < limit; i++) {
              const aid = artistIds[i];
              const bucket = byArtist.get(aid);
              if (!bucket || bucket.length === 0) continue;
              const pickIndex = Math.floor(Math.random() * bucket.length);
              const pick = bucket.splice(pickIndex, 1)[0];
              result.push(pick);
              if (bucket.length === 0) {
                artistIds.splice(i, 1);
                i--;
              }
            }
          }
          const seenUris = new Set(result.map(r => r.uri));
          for (const t of tracksList) {
            if (result.length >= limit) break;
            if (!seenUris.has(t.uri)) {
              result.push(t);
              seenUris.add(t.uri);
            }
          }
          return result.slice(0, limit);
        };
        tracks = diversify(tracks, recParams.limit || 20, 1);
        try {
          const recent = global.recentTracksStore.get(recentKey) || [];
          if (recent.length > 0) tracks = tracks.filter(t => !recent.includes(t.uri));
        } catch (ferr) {
          console.warn('Could not filter recent tracks (fallback):', ferr);
        }
        const urisToStore = tracks.map(t => t.uri).filter(Boolean);
        const prev = global.recentTracksStore.get(recentKey) || [];
        const merged = [...urisToStore, ...prev].slice(0, 100);
        global.recentTracksStore.set(recentKey, merged);
      } catch (searchErr) {
        console.error('Search fallback also failed:', searchErr.response?.status, searchErr.response?.data || searchErr.message);
        throw searchErr; // bubble up to outer catch
      }
    }

    // Final safety: if we somehow have no tracks at this point, try one last lightweight search
    if (!tracks || tracks.length === 0) {
      console.warn('No tracks collected by recommendations or fallback — performing final safety search');
      try {
        const safetyQueries = [chosenGenre, genre, mood, `${mood} mix`].filter(Boolean);
        const safetyMap = new Map();
        for (const q of safetyQueries) {
          try {
            const sRes = await axios.get('https://api.spotify.com/v1/search', {
              headers: { Authorization: `Bearer ${access_token}` },
              params: { q, type: 'track', limit: 30, market: 'US' }
            });
            const items = (sRes.data.tracks && sRes.data.tracks.items) || [];
            for (const it of items) if (it && it.uri) safetyMap.set(it.uri, it);
          } catch (sqErr) {
            console.warn('Safety search query failed for', q, sqErr.response?.status || sqErr.message);
          }
        }
        tracks = Array.from(safetyMap.values()).slice(0, 20);
      } catch (sErr) {
        console.warn('Final safety search failed:', sErr.response?.status || sErr.message || sErr);
      }
    }

    // 2) Get current user's id
    const meRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const userId = meRes.data.id;

    // 3) Create a new playlist for the user
  const playlistName = `Mood: ${mood.charAt(0).toUpperCase() + mood.slice(1)} Playlist - ${Date.now()}`;
    const createRes = await axios.post(
      `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`,
      {
        name: playlistName,
        description: `A playlist generated for mood: ${mood}`,
        public: false,
      },
      { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
    );

    const playlist = createRes.data;

    // 4) Add tracks to the playlist
    const uris = tracks.map(t => t.uri).filter(Boolean);
    if (uris.length > 0) {
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlist.id}/tracks`,
        { uris },
        { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
      );
    }

    // Respond with created playlist info and tracks for the frontend to display
    res.json({ playlist, tracks });
  } catch (err) {
    console.error("==== SPOTIFY ERROR DETAILS ====");
    console.error("Request URL:", err.config?.url);
    console.error("Request params:", err.config?.params || { seed_genres: genre, limit: 20, market: "US" });
    console.error("Status:", err.response?.status);
    console.error("Message:", err.response?.data || err.message || err);
    console.error("Headers:", err.response?.headers);
    console.error("===============================");
    const status = err.response?.status || 500;
    return res.status(status).json({ error: "Spotify request failed", status, detail: err.response?.data || err.message });
  }
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
