Local setup for Mood Playlist Client

1) Set backend URL for development

Create a file named `.env` in the `frontend/mood-playlist-client/` folder with the following content:

VITE_BACKEND_URI=http://localhost:5001

If you use an ngrok URL for your backend, set that value instead.

2) Start the frontend

Install and run the dev server:

npm install
npm run dev

3) After logging in via Spotify, the backend will redirect to the frontend with tokens in the URL. The app stores the access token in localStorage and uses it when generating playlists.

---
Backend notes

The backend expects the following environment variables in `backend/.env`:

CLIENT_ID=your_spotify_client_id
CLIENT_SECRET=your_spotify_client_secret
REDIRECT_URI=http://localhost:5001/callback   # or your publicly accessible ngrok URL
FRONTEND_URI=http://localhost:5173            # where the frontend is served

Start the backend with:

npm install
npm start

Replace URLs with your ngrok URL if you're testing from a remote device.
