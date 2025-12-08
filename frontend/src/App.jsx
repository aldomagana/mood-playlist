import React, { useEffect, useState } from 'react';
import Login from './components/login';
import Dashboard from './components/dashboard';

export default function App() {
  const [token, setToken] = useState('');

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const access_token = urlParams.get('access_token');
    const refresh_token = urlParams.get('refresh_token');
    const expires_in = urlParams.get('expires_in');

    if (access_token) {
      localStorage.setItem('access_token', access_token);
      if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
      if (expires_in) localStorage.setItem('expires_in', expires_in);
      setToken(access_token);
      // clear query params
      window.history.replaceState({}, '', '/');
    } else {
      const stored = localStorage.getItem('access_token');
      if (stored) setToken(stored);
    }
  }, []);

  return token ? <Dashboard token={token} setToken={setToken} /> : <Login />;
}


