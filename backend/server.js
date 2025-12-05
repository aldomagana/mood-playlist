// CLEAN SERVER.JS — START FRESH

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const querystring = require("querystring");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// ----------------------
// 1) TEST ROUTE
// ----------------------
app.get("/", (req, res) => res.send("Backend is running!"));

// ----------------------
// 2) LOGIN ROUTE
// ----------------------
app.get("/login", (req, res) => {
  const scope = [
    "user-read-private",
    "user-read-email",
    "playlist-modify-private",
    "playlist-modify-public"
  ].join(" ");

  const params = querystring.stringify({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: scope,
    redirect_uri: REDIRECT_URI,
  });

  res.redirect("https://accounts.spotify.com/authorize?" + params);
});

// ----------------------
// 3) CALLBACK ROUTE
// ----------------------
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenResponse = await axios.post(
      "https://accounts.spotify.com/api/token",
      querystring.stringify({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
        },
      }
    );

    res.json(tokenResponse.data); // contains access_token + refresh_token

  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message);
    res.status(400).json({ error: "Failed to get access token" });
  }
});

// ----------------------
// 4) GENERATE PLAYLIST
// ----------------------
app.post('/generate', async (req, res) => {
    const { mood, accessToken } = req.body;

    if (!mood) {
        return res.status(400).json({ error: "Mood is required" });
    }

    if (!accessToken) {
        return res.status(400).json({ error: "Spotify accessToken is required" });
    }

    try {
        // Search Spotify with mood term
        const response = await axios.get("https://api.spotify.com/v1/search", {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            params: {
                q: mood,
                type: "track",
                limit: 10,
                market: "US"
            }
        });

        const tracks = response.data.tracks.items;

        return res.json({
            success: true,
            playlist: tracks
        });

    } catch (error) {
        console.error(error.response?.data || error.message);

        return res.status(500).json({
            error: "Spotify API request failed",
            details: error.response?.data || error.message
        });
    }
});

// ----------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

