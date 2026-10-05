const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay,
  S_WHATSAPP_NET
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

// Helper from Mais-project: wait for the socket connection to be fully ready
function waitForSocketOpen(sock, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let timer;
    const cleanup = (ok) => {
      clearTimeout(timer);
      try { sock.ev.off("connection.update", onUpd); } catch (_) {}
      resolve(ok);
    };
    timer = setTimeout(() => cleanup(false), timeoutMs);

    const isReady = () => sock?.ws?.readyState === 1 || sock?.ws?.socket?.readyState === 1;
    if (isReady()) return cleanup(true);

    const onUpd = (update = {}) => {
      if (update?.connection === "open" || isReady()) cleanup(true);
    };
    try { sock.ev.on("connection.update", onUpd); } catch (_) {}

    const poll = setInterval(() => {
      if (isReady()) {
        clearInterval(poll);
        cleanup(true);
      }
    }, 250);
    setTimeout(() => clearInterval(poll), timeoutMs);
  });
}

function sanitizeNumber(input) {
  if (!input) return "";
  let digits = String(input).replace(/[^0-9]/g, "");
  // Support Nigerian local 080..., 090... -> 23480..., 23490...
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "234" + digits.substring(1);
  }
  return digits;
}

function cleanupSession(sessionId, sessionDir, imagePath) {
  try {
    if (sessionDir && fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[${sessionId}] Cleaned session files`);
    }
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      console.log(`[${sessionId}] Cleaned image upload`);
    }
  } catch (err) {
    console.error(`[${sessionId}] Cleanup error:`, err.message);
  }
}

Router.get("/", async (req, res) => {
  if (!req.query.filename) {
    return res.status(400).json({ error: "Filename is required" });
  }
  if (!req.query.phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  const rawNumber = sanitizeNumber(req.query.phoneNumber);
  if (!rawNumber || rawNumber.length < 9) {
    return res.status(400).json({ error: "Invalid phone number. Include your country code." });
  }

  const imagePath = path.join(__dirname, "../uploads", decodeURIComponent(req.query.filename));
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: "Image file not found on server" });
  }

  const sessionId = req.query.sessionId || Date.now().toString(36);
  const sessionDir = path.join(__dirname, "../sessions", sessionId);

  // Clean start for fresh pairing keys
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  sessionStatus.set(sessionId, {
    status: "connecting",
    step: 1,
    message: "Connecting to WhatsApp servers..."
  });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const startSocket = async (isRestart = false) => {
      const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        // Proven browser identity from Mais-project that WhatsApp reliably accepts for pairing codes
        browser: ["Mac OS", "Chrome", "121.0.6167.85"],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        emitOwnEvents: true,
        markOnlineOnConnect: false
      });

      const safeSaveCreds = async () => {
        try {
          if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
          await saveCreds();
        } catch (_) {}
      };
      sock.ev.on("creds.update", safeSaveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          console.log(`[${sessionId}] Connection closed with code:`, statusCode);

          if (statusCode === DisconnectReason.loggedOut) {
            sessionStatus.set(sessionId, {
              status: "logged_out",
              step: 6,
              message: "Logged out from WhatsApp."
            });
            cleanupSession(sessionId, sessionDir, imagePath);
          } else if (statusCode === DisconnectReason.restartRequired) {
            // CRITICAL FIX: WhatsApp pairing code linking requires restart on code 515!
            console.log(`[${sessionId}] Restart required after phone confirmation — reconnecting...`);
            sessionStatus.set(sessionId, {
              status: "restarting",
              step: 2,
              message: "Device recognized! Completing link handshake..."
            });
            await delay(1500);
            startSocket(true);
          }
        } else if (connection === "open") {
          console.log(`[${sessionId}] WhatsApp linked successfully:`, sock.user?.id);
          sessionStatus.set(sessionId, {
            status: "linked",
            step: 3,
            message: "WhatsApp linked! Generating full-screen DP..."
          });

          await delay(600);

          if (!fs.existsSync(imagePath)) {
            sessionStatus.set(sessionId, { status: "error", message: "Image not found for DP upload" });
            cleanupSession(sessionId, sessionDir, imagePath);
            return;
          }

          const imageBuffer = fs.readFileSync(imagePath);
          try {
            sessionStatus.set(sessionId, {
              status: "uploading_dp",
              step: 4,
              message: "Uploading full-screen profile picture..."
            });

            // Uses original Jimp logic with getWidth, getHeight, crop, scaleToFit, normalize
            const { img } = await generateProfilePicture(imageBuffer);
            await sock.query({
              tag: "iq",
              attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
              content: [{ tag: "picture", attrs: { type: "image" }, content: img }]
            });

            await delay(600);
            sessionStatus.set(sessionId, {
              status: "dp_done",
              step: 5,
              message: "Done! Profile picture updated to full screen. 🎉"
            });

            try {
              await sock.sendMessage(sock.user.id, {
                text: "*_Profile picture updated successfully! Full screen edge-to-edge applied._*\n\n_*Made by JUST X*_"
              });
            } catch (_) {}
          } catch (err) {
            console.error(`[${sessionId}] Error updating DP:`, err);
            sessionStatus.set(sessionId, {
              status: "error",
              message: "Failed to upload DP: " + err.message
            });
          }

          await delay(1200);
          sessionStatus.set(sessionId, {
            status: "logging_out",
            step: 6,
            message: "Done logging out from WhatsApp..."
          });

          try { await sock.logout(); } catch (_) {}

          sessionStatus.set(sessionId, {
            status: "clearing",
            step: 7,
            message: "All work cleared! Session & uploads deleted."
          });
          cleanupSession(sessionId, sessionDir, imagePath);

          sessionStatus.set(sessionId, {
            status: "completed",
            step: 8,
            message: "Complete! Everything finished and clean. ✅"
          });
        }
      });

      return sock;
    };

    const initialSock = await startSocket(false);

    // Wait for the websocket to actually open before requesting pairing code (like Mais-project)
    const isReady = await waitForSocketOpen(initialSock, 20000);
    if (!isReady) {
      sessionStatus.set(sessionId, { status: "error", message: "Connection to WhatsApp timed out. Please retry." });
      if (!res.headersSent) {
        return res.status(504).json({ error: "Could not reach WhatsApp servers. Please retry." });
      }
      return;
    }

    await delay(500);

    // Request pairing code with retry logic (up to 3 attempts)
    let pairingCode = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sessionStatus.set(sessionId, {
          status: "requesting_code",
          step: 1,
          message: `Requesting pairing code (attempt ${attempt})...`
        });

        pairingCode = await initialSock.requestPairingCode(rawNumber);
        if (pairingCode) {
          pairingCode = pairingCode.match(/.{1,4}/g)?.join("-") || pairingCode;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[${sessionId}] Pairing code attempt ${attempt} failed:`, err.message);
        await delay(1500);
      }
    }

    if (!pairingCode) {
      const errMsg = lastError?.message || "WhatsApp did not return a pairing code";
      sessionStatus.set(sessionId, { status: "error", message: errMsg });
      if (!res.headersSent) {
        return res.status(500).json({ error: errMsg });
      }
      return;
    }

    console.log(`[${sessionId}] Generated pairing code: ${pairingCode} for ${rawNumber}`);

    sessionStatus.set(sessionId, {
      status: "waiting_link",
      step: 2,
      code: pairingCode,
      message: "Pairing code ready! Enter this code in WhatsApp > Linked Devices."
    });

    if (!res.headersSent) {
      return res.status(200).json({
        code: pairingCode,
        sessionId: sessionId,
        phoneNumber: rawNumber
      });
    }

  } catch (err) {
    console.error(`[${sessionId}] Fatal error:`, err);
    sessionStatus.set(sessionId, { status: "error", message: err.message });
    cleanupSession(sessionId, sessionDir, imagePath);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to initialize pairing", details: err.message });
    }
  }
});

module.exports = Router;
