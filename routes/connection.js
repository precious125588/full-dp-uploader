const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay,
  S_WHATSAPP_NET,
  Browsers
} = require("baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const express = require("express");
const Router = express.Router();
const fs = require("fs");
const path = require("path");
const generateProfilePicture = require("../utils/functions");

// In-memory status tracker for live monitoring
const sessionStatus = new Map();

Router.get("/status", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !sessionStatus.has(sessionId)) {
    return res.status(200).json({ status: "idle", message: "Ready to pair" });
  }
  return res.status(200).json(sessionStatus.get(sessionId));
});

Router.get("/", async (req, res) => {
  if (!req.query.filename) {
    return res.status(400).json({ error: "Filename is required" });
  }
  if (!req.query.phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Sanitize phone number: supports +23490..., 23490..., and local 090... formats
  let rawNumber = req.query.phoneNumber.replace(/[^0-9]/g, "");
  if (rawNumber.startsWith("0") && rawNumber.length >= 10) {
    rawNumber = "234" + rawNumber.substring(1); // local 090... -> 23490...
  }

  const imagePath = path.join(__dirname, "../uploads", decodeURIComponent(req.query.filename));
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: "Image file not found" });
  }

  const sessionId = req.query.sessionId || Date.now().toString(36);
  const sessionDir = path.join(__dirname, "../sessions", sessionId);

  // FIX 1: every pairing attempt gets a brand-new isolated session directory.
  // Reused/corrupted session keys are what cause the "incorrect code" error on the phone.
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  sessionStatus.set(sessionId, { status: "initializing", step: 1, message: "Initializing fresh WhatsApp session..." });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const socket = makeWASocket({
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      // FIX 2: the "Pair with this device?" push notification only pops when the
      // socket identifies as a real browser build. Browsers.ubuntu("Chrome") does that.
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    // FIX 3: wait for the initial handshake so WhatsApp registers this device session
    // before requesting the code — this is what makes the notification pop on the phone.
    sessionStatus.set(sessionId, { status: "handshaking", step: 1, message: "Connecting to WhatsApp servers..." });
    await delay(2500);

    if (!socket.authState.creds.registered) {
      sessionStatus.set(sessionId, { status: "requesting_code", step: 1, message: "Requesting pairing code..." });

      const pairingCode = await socket.requestPairingCode(rawNumber);
      console.log(`[${sessionId}] Pairing code for ${rawNumber}: ${pairingCode}`);

      sessionStatus.set(sessionId, {
        status: "waiting_link",
        step: 2,
        code: pairingCode,
        message: "Pairing notification sent! Check your phone, or enter the code in Linked Devices"
      });

      if (!res.headersSent) {
        res.status(200).json({ code: pairingCode, sessionId: sessionId, formattedNumber: rawNumber });
      }
    }

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`[${sessionId}] Connection closed:`, statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          sessionStatus.set(sessionId, { status: "logged_out", step: 6, message: "Logged out. Cleaning up..." });
          cleanupSession(sessionId, sessionDir, imagePath);
        } else if (
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.timedOut
        ) {
          console.log(`[${sessionId}] Reconnecting socket...`);
        }
      } else if (connection === "open") {
        console.log(`[${sessionId}] WhatsApp linked:`, socket.user?.id);
        sessionStatus.set(sessionId, { status: "linked", step: 3, message: "WhatsApp linked successfully! Processing full-screen DP..." });

        await delay(500);
        try { await socket.sendMessage(socket.user.id, { text: "_*Connected to WhatsApp Full Screen DP Uploader*_" }); } catch (_) {}

        if (!fs.existsSync(imagePath)) {
          sessionStatus.set(sessionId, { status: "error", message: "Uploaded image missing" });
          cleanupSession(sessionId, sessionDir, imagePath);
          return;
        }

        const imageBuffer = fs.readFileSync(imagePath);
        try {
          sessionStatus.set(sessionId, { status: "uploading_dp", step: 4, message: "Uploading full-screen profile picture..." });

          const { img } = await generateProfilePicture(imageBuffer);
          await socket.query({
            tag: "iq",
            attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
            content: [{ tag: "picture", attrs: { type: "image" }, content: img }]
          });

          await delay(500);
          sessionStatus.set(sessionId, { status: "dp_done", step: 5, message: "Done! Profile picture updated to full screen. 🎉" });

          try {
            await socket.sendMessage(socket.user.id, {
              text: "*_Profile picture updated successfully! Now your profile looks sharp edge-to-edge._*\n\n_*Thanks for using Full DP Uploader. ❤️*_"
            });
          } catch (_) {}
        } catch (err) {
          console.error(`[${sessionId}] Error updating DP:`, err);
          sessionStatus.set(sessionId, { status: "error", message: "Failed to update profile picture" });
        }

        await delay(1200);
        sessionStatus.set(sessionId, { status: "logging_out", step: 6, message: "Done logging out of WhatsApp..." });
        try { await socket.logout(); } catch (_) {}

        sessionStatus.set(sessionId, { status: "clearing", step: 7, message: "Clearing session and temporary image..." });
        cleanupSession(sessionId, sessionDir, imagePath);

        sessionStatus.set(sessionId, { status: "completed", step: 8, message: "All work cleared! ✅" });
      }
    });

    socket.ev.on("creds.update", saveCreds);

  } catch (err) {
    console.error(`[${sessionId}] Socket initialization error:`, err);
    sessionStatus.set(sessionId, { status: "error", message: err.message });
    cleanupSession(sessionId, sessionDir, imagePath);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate pairing code", details: err.message });
    }
  }
});

function cleanupSession(sessionId, sessionDir, imagePath) {
  try {
    if (sessionDir && fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[${sessionId}] Removed session dir`);
    }
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      console.log(`[${sessionId}] Removed image file`);
    }
  } catch (err) {
    console.error(`[${sessionId}] Error during cleanup:`, err);
  }
}

module.exports = Router;
