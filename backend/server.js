const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dns = require("dns");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Chat = require("./models/Chat");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Unauthorized socket"));
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret_change_me",
    );

    socket.user = {
      id: decoded.id,
      name: decoded.name,
      email: decoded.email,
    };

    return next();
  } catch (_error) {
    return next(new Error("Unauthorized socket"));
  }
});

app.set("io", io);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/chats", require("./routes/chatRoutes"));

// Environment Variables
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const DNS_SERVERS = (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
  .split(",")
  .map((server) => server.trim())
  .filter(Boolean);

io.on("connection", (socket) => {
  if (socket.user?.id) {
    socket.join(`user:${socket.user.id}`);
  }

  console.log(`🔌 Socket connected: ${socket.id}`);

  socket.on("typing", async ({ chatId, isTyping }) => {
    try {
      if (!chatId) {
        return;
      }

      const chat = await Chat.findById(chatId).select("participants");
      if (!chat) {
        return;
      }

      const isParticipant = chat.participants.some(
        (participant) => participant.id.toString() === socket.user.id,
      );

      if (!isParticipant) {
        return;
      }

      chat.participants.forEach((participant) => {
        const participantId = participant.id.toString();
        if (participantId === socket.user.id) {
          return;
        }

        io.to(`user:${participantId}`).emit("typing", {
          chatId,
          userId: socket.user.id,
          userName: socket.user.name,
          isTyping: Boolean(isTyping),
        });
      });
    } catch (_error) {
      // ignore typing relay errors
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });
});

// Database + Server Start
const startServer = async () => {
  try {
    if (!MONGO_URI) {
      throw new Error("MONGO_URI not defined in .env");
    }

    if (MONGO_URI.startsWith("mongodb+srv://") && DNS_SERVERS.length > 0) {
      dns.setServers(DNS_SERVERS);
    }

    try {
      await mongoose.connect(MONGO_URI);
    } catch (connectError) {
      const shouldRetryWithAdminAuthSource =
        connectError.message.toLowerCase().includes("bad auth") &&
        MONGO_URI.startsWith("mongodb+srv://") &&
        !/[?&]authSource=/.test(MONGO_URI);

      if (!shouldRetryWithAdminAuthSource) {
        throw connectError;
      }

      const separator = MONGO_URI.includes("?") ? "&" : "?";
      const mongoUriWithAdminAuthSource = `${MONGO_URI}${separator}authSource=admin`;

      await mongoose.connect(mongoUriWithAdminAuthSource);
    }

    console.log("✅ MongoDB Connected Successfully");

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
};

startServer();