import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_BASE_URL = import.meta.env.VITE_API_URL || "https://real-time-chat-backend-uvr5.onrender.com";
const AUTH_STORAGE_KEY = "chat-auth";
const RTC_CONFIGURATION = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function ChatInterface({ auth, onLogout }) {
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
  const [timestampUpdate, setTimestampUpdate] = useState(0);
  const [showSidebar, setShowSidebar] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [unreadByChat, setUnreadByChat] = useState({});

  useEffect(() => {
    const interval = setInterval(() => {
      setTimestampUpdate(prev => prev + 1);
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

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
    // Ensure message has a valid timestamp
    const messageWithTimestamp = {
      ...message,
      createdAt: message.createdAt || new Date().toISOString(),
    };

    setChats((prevChats) =>
      prevChats.map((chat) => {
        if (chat._id !== chatId) {
          return chat;
        }

        // Check if message already exists by ID
        const hasMessage = chat.messages.some((msg) => msg._id === messageWithTimestamp._id);
        if (hasMessage) {
          return chat;
        }

        // Also check if message already exists by content (to avoid duplicates from optimistic sends)
        const hasIdenticalMessage = chat.messages.some(
          (msg) =>
            msg.text === messageWithTimestamp.text &&
            msg.senderId === messageWithTimestamp.senderId &&
            Math.abs(new Date(msg.createdAt).getTime() - new Date(messageWithTimestamp.createdAt).getTime()) < 1000
        );
        
        if (hasIdenticalMessage) {
          // Replace temp message with server message if senderId and text match
          return {
            ...chat,
            messages: chat.messages.map((msg) =>
              msg.text === messageWithTimestamp.text &&
              msg.senderId === messageWithTimestamp.senderId &&
              msg._id.startsWith('temp-')
                ? messageWithTimestamp
                : msg
            ),
          };
        }

        return {
          ...chat,
          messages: [...chat.messages, messageWithTimestamp],
        };
      }),
    );

    // Increment unread count if message is not from current user and chat is not active
    if (messageWithTimestamp.senderId !== auth.user.id && chatId !== activeChatId) {
      setUnreadByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || 0) + 1,
      }));
    }

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
    
    // Initialize unread count for new chat
    setUnreadByChat((prev) => ({
      ...prev,
      [incomingChat._id]: prev[incomingChat._id] ?? 0,
    }));
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
  };

  const handleEndCall = () => {
    if (socketRef.current && callChatIdRef.current) {
      socketRef.current.emit("call_end", {
        chatId: callChatIdRef.current,
      });
    }

    resetCallResources();
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

    const messageText = draft.trim();
    const messageTimestamp = new Date().toISOString();

    const tempMessage = {
      _id: `temp-${Date.now()}`,
      text: messageText,
      senderId: auth.user.id,
      createdAt: messageTimestamp,
    };

    // Optimistically add the message to UI
    setChats((prevChats) =>
      prevChats.map((chat) => {
        if (chat._id !== activeChat._id) {
          return chat;
        }
        return {
          ...chat,
          messages: [...chat.messages, tempMessage],
        };
      }),
    );

    setDraft("");
    emitTyping(false);

    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/chats/${activeChat._id}/messages`,
        { text: messageText },
        { headers: authHeaders },
      );

      // Ensure server response has a valid timestamp
      const serverMessage = {
        ...response.data,
        createdAt: response.data.createdAt || messageTimestamp,
      };

      // Replace temp message with real message from server
      setChats((prevChats) =>
        prevChats.map((chat) => {
          if (chat._id !== activeChat._id) {
            return chat;
          }
          return {
            ...chat,
            messages: chat.messages.map((msg) =>
              msg._id === tempMessage._id ? serverMessage : msg
            ),
          };
        }),
      );
      setError("");
    } catch {
      // Remove temp message on error
      setChats((prevChats) =>
        prevChats.map((chat) => {
          if (chat._id !== activeChat._id) {
            return chat;
          }
          return {
            ...chat,
            messages: chat.messages.filter((msg) => msg._id !== tempMessage._id),
          };
        }),
      );
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
        // Ensure all messages have timestamps
        const chatsWithTimestamps = chatsResponse.data.map(chat => ({
          ...chat,
          messages: chat.messages.map(message => ({
            ...message,
            createdAt: message.createdAt || new Date().toISOString(),
          })),
        }));
        setChats(chatsWithTimestamps);
        
        // Initialize unread counts (all 0 on load)
        const unreadMap = {};
        chatsResponse.data.forEach((chat) => {
          unreadMap[chat._id] = 0;
        });
        setUnreadByChat(unreadMap);
        
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

  // Clear unread count when switching to a chat
  useEffect(() => {
    if (activeChatId) {
      setUnreadByChat((prev) => ({
        ...prev,
        [activeChatId]: 0,
      }));
    }
  }, [activeChatId]);

  useEffect(() => () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
  }, []);

  const filteredUsers = users.filter((user) =>
    user.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const filteredChats = chats.filter((chat) =>
    getChatTitle(chat).toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const formatMessageTime = (timestamp) => {
    if (!timestamp) {
      // Fallback to current time if no timestamp provided
      return new Date().toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    }

    // Handle various date formats
    let messageDate;

    if (typeof timestamp === 'string') {
      messageDate = new Date(timestamp);
    } else if (typeof timestamp === 'number') {
      messageDate = new Date(timestamp);
    } else {
      // Fallback to current time for invalid types
      return new Date().toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    }

    // Check if date is valid
    if (isNaN(messageDate.getTime())) {
      // Fallback to current time for invalid dates
      return new Date().toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    }

    // Format: "Mar 9, 2025 2:30:45 PM"
    const dateStr = messageDate.toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const timeStr = messageDate.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    return `${dateStr} ${timeStr}`;
  };

  const handleLogout = () => {
    resetCallResources();
    onLogout();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg">Loading chats...</div>
      </div>
    );
  }

  return (
    <div className={`flex min-h-screen bg-gray-100 ${showSidebar ? '' : 'sidebar-hidden'}`}>
      <aside className={`w-80 bg-white border-r border-gray-200 flex flex-col ${showSidebar ? '' : 'hidden'}`}>
        <header className="p-4 border-b border-gray-200 flex items-center">
          <div className="flex items-center space-x-2">
            <span className="font-medium text-gray-900">{auth.user.name}</span>
            <button
              onClick={handleLogout}
              className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
            >
              Logout
            </button>
          </div>
        </header>

        <div className="p-4 border-b border-gray-200">
          <input
            type="text"
            placeholder="Search users/chats..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <section className="flex-1 overflow-y-auto">
          <div className="p-4">
            <h3 className="font-medium text-gray-900 mb-2">Users</h3>
            <ul className="space-y-2">
              {filteredUsers.map((user) => {
                const userChat = chats.find((chat) =>
                  chat.participants?.some((p) => p.id === user.id),
                );
                const unreadCount = unreadByChat[userChat?._id] || 0;

                return (
                  <li
                    key={user.id}
                    onClick={() => userChat && setActiveChatId(userChat._id)}
                    className={`flex items-center justify-between p-3 rounded-md cursor-pointer ${
                      userChat?._id === activeChatId ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex-1">
                      <div className="text-gray-700 font-medium">{user.name}</div>
                      {userChat?.messages.length > 0 && (
                        <div className="text-xs text-gray-500 truncate">
                          {userChat.messages[userChat.messages.length - 1].text}
                        </div>
                      )}
                    </div>
                    <div className="ml-2 flex flex-col items-end">
                      {unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center w-6 h-6 text-xs font-bold text-white bg-red-500 rounded-full">
                          {unreadCount}
                        </span>
                      )}
                      {!userChat && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartChat(user.id);
                          }}
                          className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
                        >
                          Chat
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </aside>

      <main className="flex-1 flex flex-col">
        {!activeChat ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              Start a chat with a user from the left panel.
            </div>
          </div>
        ) : (
          <>
            <header className="bg-white border-b border-gray-200 p-4 flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <h2 className="text-xl font-semibold text-gray-900">{getChatTitle(activeChat)}</h2>
              </div>

              <div className="flex space-x-2">
                {callState === "in-call" && callChatId === activeChat._id && (
                  <button
                    onClick={handleEndCall}
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    End Call
                  </button>
                )}
                {callState === "ringing" && incomingCall?.chatId === activeChat._id && (
                  <>
                    <button
                      onClick={handleAcceptCall}
                      className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                    >
                      Accept
                    </button>
                    <button
                      onClick={handleRejectCall}
                      className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                    >
                      Reject
                    </button>
                  </>
                )}
                {callState === "calling" && callChatId === activeChat._id && (
                  <button
                    onClick={handleEndCall}
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    Cancel Call
                  </button>
                )}
                {callState === "idle" && (
                  <button
                    onClick={handleStartCall}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    Video Call
                  </button>
                )}
              </div>
            </header>

            {(callChatId === activeChat._id || incomingCall?.chatId === activeChat._id) && (
              <section className="flex-1 bg-black relative flex items-center justify-center overflow-hidden">
                {/* Main video */}
                <div className="w-full h-full bg-gray-900 flex items-center justify-center relative">
                  {remoteStream ? (
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-white text-2xl">Waiting for {getChatTitle(activeChat)}...</div>
                  )}

                  {/* Picture-in-picture local video */}
                  <div className="absolute bottom-6 right-6 w-48 h-40 bg-gray-800 rounded-lg overflow-hidden border-2 border-white shadow-lg">
                    {localStream ? (
                      <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-white text-sm">
                        Camera preview
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section className="flex-1 overflow-y-auto p-4 space-y-4">
              {activeChat.messages.map((message) => (
                <div
                  key={message._id}
                  className={`flex ${message.senderId === auth.user.id ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                      message.senderId === auth.user.id
                        ? 'bg-blue-500 text-white'
                        : 'bg-white border border-gray-200 text-gray-900'
                    }`}
                  >
                    <p className="mb-1">{message.text}</p>
                    <time key={timestampUpdate} className={`block text-xs ${
                      message.senderId === auth.user.id
                        ? 'text-blue-100'
                        : 'text-gray-500'
                    }`}>
                      {formatMessageTime(message.createdAt)}
                    </time>
                  </div>
                </div>
              ))}
            </section>

            <form onSubmit={handleSendMessage} className="border-t border-gray-200 p-4">
              <div className="flex space-x-2">
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);

                    if (!e.target.value.trim()) {
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
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </form>

            {typingByChat[activeChat._id] && (
              <div className="px-4 py-2 text-sm text-gray-500 italic">
                {typingByChat[activeChat._id]} is typing...
              </div>
            )}
          </>
        )}

        {error && (
          <div className="fixed bottom-4 right-4 bg-red-500 text-white px-4 py-2 rounded shadow-lg">
            {error}
          </div>
        )}
      </main>
    </div>
  );
}

export default ChatInterface;
