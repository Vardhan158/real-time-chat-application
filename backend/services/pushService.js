const webpush = require("web-push");
const User = require("../models/User");

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const isPushConfigured = Boolean(
  vapidPublicKey && vapidPrivateKey && vapidSubject,
);

if (isPushConfigured) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

const sanitizeSubscription = (subscription) => {
  if (
    !subscription ||
    typeof subscription.endpoint !== "string" ||
    typeof subscription.keys?.p256dh !== "string" ||
    typeof subscription.keys?.auth !== "string"
  ) {
    return null;
  }

  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };
};

const removeSubscriptionByEndpoint = async (userId, endpoint) => {
  if (!endpoint) {
    return;
  }

  await User.updateOne(
    { _id: userId },
    { $pull: { pushSubscriptions: { endpoint } } },
  );
};

const sendNotificationToUser = async (userId, payload) => {
  if (!isPushConfigured) {
    return;
  }

  const user = await User.findById(userId).select("pushSubscriptions");
  if (!user?.pushSubscriptions?.length) {
    return;
  }

  const body = JSON.stringify(payload);

  await Promise.all(
    user.pushSubscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription.toObject(), body);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await removeSubscriptionByEndpoint(userId, subscription.endpoint);
        }
      }
    }),
  );
};

module.exports = {
  getPublicVapidKey: () => vapidPublicKey,
  isPushConfigured,
  sanitizeSubscription,
  removeSubscriptionByEndpoint,
  sendNotificationToUser,
};
