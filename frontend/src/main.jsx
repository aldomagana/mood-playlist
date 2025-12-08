import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";         // keep App import if you plan to render it later
import "./index.css";            // optional global styles

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />                     {/* render App, which can internally render Login */}
  </React.StrictMode>
);

