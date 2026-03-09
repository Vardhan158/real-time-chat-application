import { useState } from "react";
import AuthPage from "./pages/AuthPage";
import ChatInterface from "./components/ChatInterface";

const AUTH_STORAGE_KEY = "chat-auth";

function App() {
  const [auth, setAuth] = useState(() => {
    const saved = sessionStorage.getItem(AUTH_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  });

  const handleAuthSuccess = (authData) => {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authData));
    setAuth(authData);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    setAuth(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {!auth ? (
        <AuthPage onAuthSuccess={handleAuthSuccess} />
      ) : (
        <ChatInterface auth={auth} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;
