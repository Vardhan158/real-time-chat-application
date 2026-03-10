import { useState } from "react";
import axios from "axios";

const API_BASE_URL = "https://real-time-chat-backend-uvr5.onrender.com";

function AuthPage({ onAuthSuccess }) {
  const [authMode, setAuthMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const handleInputChange = (setter) => (event) => {
    setter(event.target.value);
    if (authError) setAuthError("");
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();

    const endpoint =
      authMode === "signup" ? `${API_BASE_URL}/api/auth/register` : `${API_BASE_URL}/api/auth/login`;

    const payload =
      authMode === "signup"
        ? { name: name.trim(), email: email.trim(), password }
        : { email: email.trim(), password };

    try {
      const response = await axios.post(endpoint, payload);
      onAuthSuccess(response.data);
      setAuthError("");
      setPassword("");
    } catch (requestError) {
      const fallback =
        authMode === "signup"
          ? "Signup failed. Try different email or valid password."
          : "Login failed. Check email and password.";

      setAuthError(requestError.response?.data?.message || fallback);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-center mb-2 text-slate-900 dark:text-slate-100">
          {authMode === "signup" ? "Create Account" : "Welcome Back"}
        </h1>
        <p className="text-center text-slate-600 dark:text-slate-400 mb-6">
          Use two browser tabs and sign in with two different accounts.
        </p>

        <form onSubmit={handleAuthSubmit} className="space-y-4">
          {authMode === "signup" && (
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Name
              </label>
              <input
                id="name"
                type="text"
                placeholder="Enter your name"
                value={name}
                onChange={handleInputChange(setName)}
                required
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={handleInputChange(setEmail)}
              required
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={handleInputChange(setPassword)}
              minLength={6}
              required
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {authMode === "signup" ? "Sign Up" : "Login"}
          </button>

          {authError && (
            <div className="text-red-600 dark:text-red-400 text-sm text-center bg-red-50 dark:bg-red-900/20 p-3 rounded-md">
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setAuthMode((mode) => (mode === "signup" ? "login" : "signup"));
              setAuthError("");
            }}
            className="w-full text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 text-sm font-medium transition-colors duration-200"
          >
            {authMode === "signup"
              ? "Already have an account? Login"
              : "New user? Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default AuthPage;
