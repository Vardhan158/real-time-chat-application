const express = require("express");
const Chat = require("../models/Chat");
const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");
const { sendNotificationToUser } = require("../services/pushService");

const router = express.Router();

const getTime = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

router.use(authMiddleware);

router.get("/", async (req, res) => {
  try {
    const chats = await Chat.find({ "participants.id": req.user.id }).sort({
      updatedAt: -1,
    });

    res.json(chats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } })
      .select("name email")
      .sort({ createdAt: -1 });

    const formattedUsers = users.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
    }));

    res.json(formattedUsers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/direct", async (req, res) => {
  try {
    const { participantId } = req.body;

    if (!participantId) {
      return res.status(400).json({ message: "participantId is required" });
    }

    if (participantId === req.user.id) {
      return res.status(400).json({ message: "Cannot create chat with yourself" });
    }

    const participant = await User.findById(participantId).select("name email");
    if (!participant) {
      return res.status(404).json({ message: "Participant not found" });
    }

    const matchingChats = await Chat.find({
      "participants.id": { $all: [req.user.id, participantId] },
    });

    const existingDirectChat = matchingChats.find(
      (chat) => chat.participants.length === 2,
    );

    if (existingDirectChat) {
      return res.json(existingDirectChat);
    }

    const chat = await Chat.create({
      name: `${req.user.name} & ${participant.name}`,
      status: "Direct message",
      participants: [
        { id: req.user.id, name: req.user.name },
        { id: participant._id.toString(), name: participant.name },
      ],
      messages: [],
    });

    const io = req.app.get("io");
    if (io) {
      const payload = { chat };
      io.to(`user:${req.user.id}`).emit("chat_upsert", payload);
      io.to(`user:${participant._id.toString()}`).emit("chat_upsert", payload);
    }

    return res.status(201).json(chat);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/:chatId/messages", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Message text is required" });
    }

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const senderIsParticipant = chat.participants.some(
      (participant) => participant.id.toString() === req.user.id,
    );

    if (!senderIsParticipant) {
      return res.status(403).json({ message: "Sender is not in this chat" });
    }

    const message = {
      senderId: req.user.id,
      senderName: req.user.name,
      text: text.trim(),
      time: getTime(),
    };

    chat.messages.push(message);
    await chat.save();

    const savedMessage = chat.messages[chat.messages.length - 1];
    const io = req.app.get("io");

    if (io) {
      const payload = {
        chatId: chat._id.toString(),
        message: savedMessage,
      };

      chat.participants.forEach((participant) => {
        io.to(`user:${participant.id.toString()}`).emit("message_created", payload);
      });
    }

    const notificationTitle =
      chat.participants.find((participant) => participant.id.toString() !== req.user.id)?.name ||
      req.user.name;

    await Promise.all(
      chat.participants
        .filter((participant) => participant.id.toString() !== req.user.id)
        .map((participant) =>
          sendNotificationToUser(participant.id.toString(), {
            title: req.user.name,
            body: savedMessage.text,
            tag: `message:${chat._id.toString()}`,
            url: `/?chatId=${chat._id.toString()}`,
            data: {
              chatId: chat._id.toString(),
              senderId: req.user.id,
              senderName: req.user.name,
              chatTitle: notificationTitle,
            },
          }),
        ),
    );

    res.status(201).json(savedMessage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
