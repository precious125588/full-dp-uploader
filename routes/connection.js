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

Router.get("/", (req, res) => {
  if (!req.query.filename) {
    return res.status(400).json({
      error: "Filename is required"
    });
  }

  const imagePath = path.join(__dirname, "../uploads", decodeURIComponent(req.query.filename));
  console.log("Processing image:", imagePath);

  const sessionId = req.query.sessionId || Date.now().toString(36);
  sessionStatus.set(sessionId, {
    status: "initializing",
    step: 1,
    message: "Initializing connection session..."
  });

  const startConnection = async () => {
    const sessionDir = path.join(__dirname, "../session");
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const socket = makeWASocket({
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers ? Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false
    });

    if (!socket.authState.creds.registered) {
      if (!req.query.phoneNumber) {
        sessionStatus.set(sessionId, { status: "error", message: "Phone number is required" });
        return res.status(400).json({
          error: "Phone number is required"
        });
      }
      const rawNumber = req.query.phoneNumber.replace(/[^0-9]/g, "");
      
      sessionStatus.set(sessionId, {
        status: "requesting_code",
        step: 1,
        message: "Requesting pairing code from WhatsApp servers..."
      });

      await delay(1500);
      let pairingCode = await socket.requestPairingCode(rawNumber);
      
      sessionStatus.set(sessionId, {
        status: "waiting_link",
        step: 2,
        code: pairingCode,
        message: "Pairing code ready! Enter it in WhatsApp -> Linked Devices -> Link with phone number"
      });

      if (!res.headersSent) {
        res.status(200).json({
          code: pairingCode,
          sessionId: sessionId
        });
      }
    }

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        console.log("Connection closed:", lastDisconnect);
        let statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.timedOut
        ) {
          sessionStatus.set(sessionId, {
            status: "reconnecting",
            step: 2,
            message: "Reconnecting to WhatsApp..."
          });
          await startConnection();
        } else if (statusCode === DisconnectReason.loggedOut) {
          sessionStatus.set(sessionId, {
            status: "logged_out",
            step: 5,
            message: "Logged out. Cleaning session."
          });
          return await clearDir();
        } else {
          socket.end("Unknown DisconnectReason: " + statusCode + "|" + connection);
        }
      } else if (connection === "open") {
        console.log("[Connected] " + JSON.stringify(socket.user.id, null, 2));

        sessionStatus.set(sessionId, {
          status: "linked",
          step: 3,
          message: "WhatsApp linked successfully! Processing full-screen DP..."
        });

        await delay(300);
        await socket.sendMessage(socket.user.id, {
          text: "_*Connected to wafullscreendp*_"
        });

        if (!fs.existsSync(imagePath)) {
          sessionStatus.set(sessionId, { status: "error", message: "Image file not found on server" });
          return res.status(404).json({
            error: "Image file not found"
          });
        }

        const imageBuffer = fs.readFileSync(imagePath);
        try {
          sessionStatus.set(sessionId, {
            status: "uploading_dp",
            step: 4,
            message: "Setting full-screen profile picture..."
          });

          const { img } = await generateProfilePicture(imageBuffer);
          await socket.query({
            tag: "iq",
            attrs: {
              to: S_WHATSAPP_NET,
              type: "set",
              xmlns: "w:profile:picture"
            },
            content: [
              {
                tag: "picture",
                attrs: {
                  type: "image"
                },
                content: img
              }
            ]
          });
          await delay(500);

          sessionStatus.set(sessionId, {
            status: "dp_done",
            step: 5,
            message: "Done! Profile picture updated to full screen."
          });

          await socket.sendMessage(socket.user.id, {
            text: "*_Profile picture updated, Now your profile looks sharp. Spread our website with your friends and family._*\n\n_*Thanks for trusting our service. ❤️*_"
          });
        } catch (err) {
          console.error("Error setting DP:", err);
          sessionStatus.set(sessionId, { status: "error", message: "Error processing profile picture" });
          await socket.sendMessage(socket.user.id, {
            text: "Error processing profile picture."
          });
        }

        await delay(1000);
        sessionStatus.set(sessionId, {
          status: "logging_out",
          step: 6,
          message: "Logging out of WhatsApp..."
        });

        await socket.logout();

        sessionStatus.set(sessionId, {
          status: "clearing",
          step: 7,
          message: "Done logging out. Clearing session and uploads..."
        });

        await clearDir();

        sessionStatus.set(sessionId, {
          status: "completed",
          step: 8,
          message: "All work cleared! Session deleted."
        });
      }
    });

    socket.ev.on("creds.update", saveCreds);
  };

  try {
    startConnection();
  } catch (err) {
    console.error(err);
    sessionStatus.set(sessionId, { status: "error", message: err.message });
    return clearDir();
  }
});

async function clearDir() {
  try {
    const uploads = path.join(__dirname, "../uploads");
    const session = path.join(__dirname, "../session");

    if (fs.existsSync(uploads)) {
      fs.rmSync(uploads, { recursive: true, force: true });
      console.log("Uploads directory deleted.");
    }
    if (fs.existsSync(session)) {
      fs.rmSync(session, { recursive: true, force: true });
      console.log("Session directory deleted.");
    }
    if (!fs.existsSync(uploads)) {
      fs.mkdirSync(uploads, { recursive: true });
      console.log("Created 'uploads' folder ✅");
    }
    if (!fs.existsSync(session)) {
      fs.mkdirSync(session, { recursive: true });
      console.log("Created 'session' folder ✅");
    }
  } catch (err) {
    console.error("Error while clearing directories:", err);
  }
}

module.exports = Router;
