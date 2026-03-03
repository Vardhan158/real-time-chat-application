import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";

const API_BASE_URL = "http://localhost:5000";
const AUTH_STORAGE_KEY = "chat-auth";
const RTC_CONFIGURATION = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function App() {
  const [auth, setAuth] = useState(() => {
    const saved = sessionStorage.getItem(AUTH_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  });

  const [authMode, setAuthMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [users, setUsers] = useState([]);
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [typingByChat, setTypingByChat] = useState({});
  const [callState, setCallState] = useState("idle");
  const [callChatId, setCallChatId] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const callChatIdRef = useRef(null);
  const incomingCallChatIdRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const authHeaders = auth?.token
    ? { Authorization: `Bearer ${auth.token}` }
    : undefined;

  const activeChat = useMemo(
    () => chats.find((chat) => chat._id === activeChatId),
    [activeChatId, chats],
  );

  const getChatTitle = (chat) => {
    if (!chat?.participants || !auth?.user) {
      return chat?.name || "Direct message";
    }

    const otherParticipant = chat.participants.find(
      (participant) => participant.id !== auth.user.id,
    );

    return otherParticipant?.name || chat.name || "Direct message";
  };

  const appendMessage = (chatId, message) => {
    setChats((prevChats) =>
      prevChats.map((chat) => {
        if (chat._id !== chatId) {
          return chat;
        }

        const hasMessage = chat.messages.some((msg) => msg._id === message._id);
        if (hasMessage) {
          return chat;
        }

        return {
          ...chat,
          messages: [...chat.messages, message],
        };
      }),
    );

    setTypingByChat((prev) => {
      if (!prev[chatId]) {
        return prev;
      }

      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  };

  const emitTyping = (isTyping) => {
    if (!socketRef.current || !activeChat?._id) {
      return;
    }

    socketRef.current.emit("typing", {
      chatId: activeChat._id,
      isTyping,
    });
  };

  const upsertChat = (incomingChat) => {
    setChats((prevChats) => {
      const index = prevChats.findIndex((chat) => chat._id === incomingChat._id);

      if (index === -1) {
        return [incomingChat, ...prevChats];
      }

      const updated = [...prevChats];
      updated[index] = incomingChat;
      return updated;
    });

    setActiveChatId((current) => current ?? incomingChat._id);
  };

  const setIncomingCallState = (callData) => {
    incomingCallChatIdRef.current = callData?.chatId ?? null;
    setIncomingCall(callData);
  };

  const resetCallResources = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    pendingCandidatesRef.current = [];
    callChatIdRef.current = null;
    incomingCallChatIdRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setCallChatId(null);
    setIncomingCall(null);
    setCallState("idle");
  };

  const initializeLocalStream = async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = mediaStream;
    setLocalStream(mediaStream);
    return mediaStream;
  };

  const createPeerConnection = (chatId) => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const connection = new RTCPeerConnection(RTC_CONFIGURATION);
    peerConnectionRef.current = connection;
    callChatIdRef.current = chatId;
    setCallChatId(chatId);
    setRemoteStream(null);

    if (localStreamRef.current) {
      localStreamRef.current
        .getTracks()
        .forEach((track) => connection.addTrack(track, localStreamRef.current));
    }

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        setRemoteStream(stream);
      }
    };

    connection.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current) {
        return;
      }

      socketRef.current.emit("call_ice_candidate", {
        chatId,
        candidate: event.candidate,
      });
    };

    return connection;
  };

  const flushPendingCandidates = async () => {
    if (!peerConnectionRef.current || pendingCandidatesRef.current.length === 0) {
      return;
    }

    const candidates = [...pendingCandidatesRef.current];
    pendingCandidatesRef.current = [];

    await Promise.all(
      candidates.map((candidate) =>
        peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate)),
      ),
    );
  };

  const handleStartCall = async () => {
    if (!activeChat?._id || !socketRef.current) {
      return;
    }

    try {
      await initializeLocalStream();
      const connection = createPeerConnection(activeChat._id);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      socketRef.current.emit("call_offer", {
        chatId: activeChat._id,
        offer,
      });

      setIncomingCallState(null);
      setCallState("calling");
      setError("");
    } catch {
      resetCallResources();
      setError("Unable to start video call. Check camera/microphone permission.");
    }
  };

  const handleAcceptCall = async () => {
    if (!incomingCall || !socketRef.current) {
      return;
    }

    try {
      await initializeLocalStream();
      const connection = createPeerConnection(incomingCall.chatId);
      await connection.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      await flushPendingCandidates();

      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      socketRef.current.emit("call_answer", {
        chatId: incomingCall.chatId,
        answer,
      });

      setActiveChatId(incomingCall.chatId);
      setIncomingCallState(null);
      setCallState("in-call");
      setError("");
    } catch {
      resetCallResources();
      setError("Unable to join video call. Try again.");
    }
  };

  const handleRejectCall = () => {
    if (!incomingCall || !socketRef.current) {
      return;
    }

    socketRef.current.emit("call_reject", {
      chatId: incomingCall.chatId,
    });

    setIncomingCallState(null);
    setCallState("idle");
    setCallChatId(null);
  };

  const handleEndCall = () => {
    if (socketRef.current && callChatIdRef.current) {
      socketRef.current.emit("call_end", {
        chatId: callChatIdRef.current,
      });
    }

    resetCallResources();
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
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(response.data));
      setAuth(response.data);
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

  const handleLogout = () => {
    resetCallResources();
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    setAuth(null);
    setUsers([]);
    setChats([]);
    setActiveChatId(null);
    setDraft("");
    setError("");
    setAuthError("");
  };

  const handleStartChat = async (participantId) => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/chats/direct`,
        { participantId },
        { headers: authHeaders },
      );

      upsertChat(response.data);
      setActiveChatId(response.data._id);
    } catch {
      setError("Unable to start chat with this user.");
    }
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();

    if (!draft.trim() || !activeChat || !authHeaders) {
      return;
    }

    try {
      await axios.post(
        `${API_BASE_URL}/api/chats/${activeChat._id}/messages`,
        { text: draft.trim() },
        { headers: authHeaders },
      );
      setDraft("");
      emitTyping(false);
      setError("");
    } catch {
      setError("Unable to send message. Check backend connection.");
    }
  };

  useEffect(() => {
    if (!auth?.token) {
      return;
    }

    const fetchUsersAndChats = async () => {
      try {
        setLoading(true);
        const headers = { Authorization: `Bearer ${auth.token}` };
        const [usersResponse, chatsResponse] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/chats/users`, { headers }),
          axios.get(`${API_BASE_URL}/api/chats`, { headers }),
        ]);

        setUsers(usersResponse.data);
        setChats(chatsResponse.data);
        setActiveChatId((current) => current ?? chatsResponse.data[0]?._id ?? null);
        setError("");
      } catch {
        setError("Unable to load users/chats. Please start backend server.");
      } finally {
        setLoading(false);
      }
    };

    fetchUsersAndChats();
  }, [auth?.token]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!auth?.token) {
      return undefined;
    }

    const socket = io(API_BASE_URL, {
      auth: {
        token: auth.token,
      },
    });

    socketRef.current = socket;

    socket.on("chat_upsert", ({ chat }) => {
      upsertChat(chat);
    });

    socket.on("message_created", ({ chatId, message }) => {
      appendMessage(chatId, message);
    });

    socket.on("typing", ({ chatId, userName, isTyping }) => {
      setTypingByChat((prev) => {
        const next = { ...prev };

        if (isTyping) {
          next[chatId] = userName;
        } else {
          delete next[chatId];
        }

        return next;
      });
    });

    socket.on("call_offer", ({ chatId, fromUserName, offer }) => {
      if (!chatId || !offer) {
        return;
      }

      setActiveChatId((current) => current ?? chatId);
      setCallChatId(chatId);
      setCallState("ringing");
      setIncomingCallState({
        chatId,
        fromUserName,
        offer,
      });
    });

    socket.on("call_answer", async ({ chatId, answer }) => {
      if (!chatId || !answer || chatId !== callChatIdRef.current || !peerConnectionRef.current) {
        return;
      }

      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        await flushPendingCandidates();
        setCallState("in-call");
      } catch {
        resetCallResources();
        setError("Video call connection failed.");
      }
    });

    socket.on("call_ice_candidate", async ({ chatId, candidate }) => {
      if (!chatId || !candidate) {
        return;
      }

      if (chatId !== callChatIdRef.current || !peerConnectionRef.current) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore invalid candidate events
      }
    });

    socket.on("call_end", ({ chatId }) => {
      if (!chatId) {
        return;
      }

      const isCurrentCall = chatId === callChatIdRef.current;
      const isIncomingCall = chatId === incomingCallChatIdRef.current;

      if (!isCurrentCall && !isIncomingCall) {
        return;
      }

      resetCallResources();
      setError("Video call ended.");
    });

    socket.on("call_reject", ({ chatId, fromUserName }) => {
      if (!chatId || chatId !== callChatIdRef.current) {
        return;
      }

      resetCallResources();
      setError(`${fromUserName || "User"} rejected the video call.`);
    });

    return () => {
      resetCallResources();
      socketRef.current = null;
      socket.disconnect();
    };
  }, [auth?.token]);

  useEffect(() => {
    if (!activeChatId && chats.length > 0) {
      setActiveChatId(chats[0]._id);
    }
  }, [activeChatId, chats]);

  useEffect(() => () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
  }, []);

  if (!auth) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={handleAuthSubmit}>
          <h1>{authMode === "signup" ? "Create Account" : "Login"}</h1>
          <p>Use two browser tabs and sign in with two different accounts.</p>

          {authMode === "signup" ? (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          ) : null}

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />
          <button type="submit">
            {authMode === "signup" ? "Sign Up" : "Login"}
          </button>

          {authError ? <span className="auth-error">{authError}</span> : null}

          <button
            className="auth-switch"
            type="button"
            onClick={() => {
              setAuthMode((mode) => (mode === "signup" ? "login" : "signup"));
              setAuthError("");
            }}
          >
            {authMode === "signup"
              ? "Already have an account? Login"
              : "New user? Create account"}
          </button>
        </form>
      </div>
    );
  }

  if (loading) {
    return <div className="chat-app">Loading chats...</div>;
  }

  return (
    <div className="chat-app">
      <aside className="chat-sidebar">
        <div className="sidebar-header">
          <h2 className="sidebar-title">Messages</h2>
          <button type="button" className="logout-button" onClick={handleLogout}>
            Logout
          </button>
        </div>
        <p className="account-name">Signed in as {auth.user.name}</p>

        <div className="user-list">
          {users.map((user) => (
            <button
              key={user.id}
              type="button"
              className="user-item"
              onClick={() => handleStartChat(user.id)}
            >
              Chat with {user.name}
            </button>
          ))}
        </div>

        <div className="chat-list">
          {chats.map((chat) => {
            const lastMessage = chat.messages[chat.messages.length - 1];
            const isActive = chat._id === activeChatId;

            return (
              <button
                key={chat._id}
                type="button"
                className={`chat-item ${isActive ? "active" : ""}`}
                onClick={() => setActiveChatId(chat._id)}
              >
                <div className="chat-item-top">
                  <span className="chat-name">{getChatTitle(chat)}</span>
                  <span className="chat-time">{lastMessage?.time}</span>
                </div>
                <div className="chat-preview">{lastMessage?.text || "No messages yet"}</div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="chat-main">
        {!activeChat ? (
          <div className="empty-chat">Start a chat with a user from the left panel.</div>
        ) : (
          <>
            <header className="chat-header">
              <div className="chat-header-top">
                <div>
                  <h3>{getChatTitle(activeChat)}</h3>
                  <p>{activeChat.status}</p>
                </div>

                <div className="call-controls">
                  {callState === "idle" ? (
                    <button type="button" onClick={handleStartCall}>
                      Video Call
                    </button>
                  ) : null}

                  {callState === "calling" && callChatId === activeChat._id ? (
                    <>
                      <span>Calling...</span>
                      <button type="button" onClick={handleEndCall}>
                        Cancel
                      </button>
                    </>
                  ) : null}

                  {callState === "ringing" && incomingCall?.chatId === activeChat._id ? (
                    <>
                      <span>{incomingCall.fromUserName} is calling...</span>
                      <button type="button" onClick={handleAcceptCall}>
                        Accept
                      </button>
                      <button type="button" onClick={handleRejectCall}>
                        Reject
                      </button>
                    </>
                  ) : null}

                  {callState === "in-call" && callChatId === activeChat._id ? (
                    <button type="button" onClick={handleEndCall}>
                      End Call
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            {(callChatId === activeChat._id || incomingCall?.chatId === activeChat._id) && (
              <section className="video-call-panel">
                <div className="video-grid">
                  <div className="video-card">
                    <span>You</span>
                    {localStream ? (
                      <video ref={localVideoRef} autoPlay muted playsInline />
                    ) : (
                      <div className="video-placeholder">Camera preview</div>
                    )}
                  </div>

                  <div className="video-card">
                    <span>{getChatTitle(activeChat)}</span>
                    {remoteStream ? (
                      <video ref={remoteVideoRef} autoPlay playsInline />
                    ) : (
                      <div className="video-placeholder">Waiting for remote video...</div>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section className="chat-messages">
              {activeChat.messages.map((message) => (
                <article
                  key={message._id}
                  className={`message ${
                    message.senderId === auth.user.id ? "message-me" : "message-them"
                  }`}
                >
                  <strong className="message-sender">{message.senderName}</strong>
                  <p>{message.text}</p>
                  <span>{message.time}</span>
                </article>
              ))}
            </section>

            <form className="chat-composer" onSubmit={handleSendMessage}>
              <input
                type="text"
                placeholder="Type a message..."
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);

                  if (!event.target.value.trim()) {
                    emitTyping(false);

                    if (typingTimeoutRef.current) {
                      clearTimeout(typingTimeoutRef.current);
                    }

                    return;
                  }

                  emitTyping(true);

                  if (typingTimeoutRef.current) {
                    clearTimeout(typingTimeoutRef.current);
                  }

                  typingTimeoutRef.current = setTimeout(() => {
                    emitTyping(false);
                  }, 1200);
                }}
                onBlur={() => emitTyping(false)}
              />
              <button type="submit">Send</button>
            </form>

            {typingByChat[activeChat._id] ? (
              <p className="typing-indicator">{typingByChat[activeChat._id]} is typing...</p>
            ) : null}
          </>
        )}

        {error ? <p className="chat-error">{error}</p> : null}
      </main>
    </div>
  );
}

export default App;
