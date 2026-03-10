const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");
const {
  getPublicVapidKey,
  isPushConfigured,
  sanitizeSubscription,
  removeSubscriptionByEndpoint,
} = require("../services/pushService");

const router = express.Router();

router.get("/public-key", (_req, res) => {
  if (!isPushConfigured) {
    return res.status(503).json({
      message: "Web push is not configured on the server.",
    });
  }

  return res.json({ publicKey: getPublicVapidKey() });
});

router.use(authMiddleware);

router.post("/subscribe", async (req, res) => {
  try {
    if (!isPushConfigured) {
      return res.status(503).json({
        message: "Web push is not configured on the server.",
      });
    }

    const subscription = sanitizeSubscription(req.body?.subscription);
    if (!subscription) {
      return res.status(400).json({ message: "Invalid push subscription." });
    }

    await User.updateOne(
      { _id: req.user.id },
      { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } },
    );

    await User.updateOne(
      { _id: req.user.id },
      { $push: { pushSubscriptions: subscription } },
    );

    return res.status(201).json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/unsubscribe", async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (!endpoint) {
      return res.status(400).json({ message: "Subscription endpoint is required." });
    }

    await removeSubscriptionByEndpoint(req.user.id, endpoint);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
