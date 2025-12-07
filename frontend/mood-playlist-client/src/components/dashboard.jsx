import { useState } from "react";

export default function Dashboard({ token, setToken }) {
  const [playlist, setPlaylist] = useState([]);
  const [error, setError] = useState('');
  const moods = ["happy", "sad", "chill", "angry", "party", "focus"];
  const BACKEND_URI = import.meta.env.VITE_BACKEND_URI || 'http://localhost:5001';

  // Generate playlist based on selected mood
  const generatePlaylist = async (selectedMood) => {
    setError('');
    try {
      const res = await fetch(`${BACKEND_URI}/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          mood: selectedMood,
          access_token: localStorage.getItem('access_token') || token
        })
      });

      if (!res.ok) {
        const text = await res.text();
        console.error('Backend error', res.status, text);
        setError(`Server error ${res.status}: ${text}`);
        setPlaylist([]);
        return;
      }

      const data = await res.json();
      console.log('Playlist response:', data);

      if (data.tracks) {
        setPlaylist(data.tracks);
      } else if (data.playlist && data.playlist.tracks) {
        setPlaylist(data.playlist.tracks.items || []);
      } else if (Array.isArray(data)) {
        setPlaylist(data);
      } else {
        setPlaylist([]);
      }

    } catch (err) {
      console.error('Frontend error:', err);
      setError(String(err));
    }
  };

  // Logout user
  const handleLogout = () => {
    setToken("");
    localStorage.removeItem("access_token");
    setPlaylist([]);
  };

  return (
    <div style={{ textAlign: "center", marginTop: "50px" }}>
      <h1>🎵 Mood Playlist Dashboard</h1>

      <button
        onClick={handleLogout}
        style={{
          position: "absolute",
          top: "20px",
          right: "20px",
          padding: "10px 20px",
          backgroundColor: "#f44336",
          color: "white",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        Logout
      </button>

      <h2>Select a Mood:</h2>
      <div style={{ display: "flex", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
        {moods.map((mood) => (
          <button
            key={mood}
            onClick={() => generatePlaylist(mood)}
            style={{
              padding: "12px 24px",
              backgroundColor: "#1DB954",
              color: "white",
              border: "none",
              borderRadius: "25px",
              cursor: "pointer",
              fontSize: "16px",
            }}
          >
            {mood.charAt(0).toUpperCase() + mood.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ color: 'red', marginTop: '20px' }}>Error: {error}</div>
      )}

      {playlist.length > 0 && (
        <div style={{ marginTop: "40px" }}>
          <h2>Your Playlist:</h2>
          <ul style={{ listStyleType: "none", padding: 0 }}>
            {playlist.map((track) => (
              <li key={track.id} style={{ margin: "10px 0" }}>
                <strong>{track.name}</strong> by {track.artists.map(a => a.name).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

