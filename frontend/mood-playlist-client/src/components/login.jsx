const BACKEND_URI = import.meta.env.VITE_BACKEND_URI || 'http://localhost:5001';

export default function Login() {
  return (
    <div style={{ textAlign: "center", marginTop: "100px" }}>
      <h1>🎵 Mood Playlist Generator</h1>
      <p>Login with Spotify to generate playlists based on your mood!</p>
      <a href={`${BACKEND_URI}/login`}>
        <button style={{
          padding: "12px 24px",
          fontSize: "18px",
          backgroundColor: "#1DB954",
          color: "white",
          border: "none",
          borderRadius: "25px",
          cursor: "pointer",
          marginTop: "20px",
        }}>
          Login with Spotify
        </button>
      </a>
    </div>
  );
}


