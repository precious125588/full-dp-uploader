const pino = require("pino");
const { Boom } = require("@hapi/boom");
const express = require("express");
const Router = express.Router();
const fs = require("fs");
const path = require("path");
const generateProfilePicture = require("../utils/functions");

let makeWASocket, useMultiFileAuthState, DisconnectReason, delay, S_WHATSAPP_NET, fetchLatestBaileysVersion;

const loadBaileys = async () => {
  if (makeWASocket) return;
  const B = await import("@whiskeysockets/baileys");
  makeWASocket = B.default || B.makeWASocket;
  useMultiFileAuthState = B.useMultiFileAuthState;
  DisconnectReason = B.DisconnectReason;
  delay = B.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  S_WHATSAPP_NET = B.S_WHATSAPP_NET || "s.whatsapp.net";
  fetchLatestBaileysVersion = B.fetchLatestBaileysVersion;
};

let _waVersionCache = { version: null, at: 0 };
const WA_VERSION_TTL = 6 * 60 * 60 * 1000;
const PAIRING_TIMEOUT_MS = 2 * 60 * 1000;

async function getWAVersion() {
  if (_waVersionCache.version && Date.now() - _waVersionCache.at < WA_VERSION_TTL) {
    return _waVersionCache.version;
  }
  try {
    if (fetchLatestBaileysVersion) {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500))
      ]);
      if (result?.version) {
        _waVersionCache = { version: result.version, at: Date.now() };
        return result.version;
      }
    }
  } catch (err) {
    console.warn(`[WA] Latest version lookup failed (${err.message}); using the version bundled with Baileys`);
  }
  return _waVersionCache.version || null;
}

const sessionStatus = new Map();
const activeSockets = new Map();
const pairingTimers = new Map();

Router.get("/status", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !sessionStatus.has(sessionId)) {
    return res.status(200).json({ status: "idle", message: "Ready to pair" });
  }
  return res.status(200).json(sessionStatus.get(sessionId));
});

function waitForSocketOpen(sock, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let timer;
    let poll;
    let settled = false;
    const isReady = () => sock?.ws?.readyState === 1 || sock?.ws?.socket?.readyState === 1;
    const cleanup = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { sock.ev.off("connection.update", onUpd); } catch (_) {}
      resolve(ok);
    };
    if (isReady()) return cleanup(true);

    const onUpd = (update = {}) => {
      if (update?.connection === "open" || isReady()) cleanup(true);
    };
    try { sock.ev.on("connection.update", onUpd); } catch (_) {}

    poll = setInterval(() => {
      if (isReady()) {
        cleanup(true);
      }
    }, 250);
    timer = setTimeout(() => cleanup(false), timeoutMs);
  });
}

function sanitizeNumber(input) {
  if (!input) return "";
  let digits = String(input).replace(/[^0-9]/g, "");
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "234" + digits.substring(1);
  }
  return digits;
}

function cleanupSession(sessionId, sessionDir, imagePath) {
  const pairingTimer = pairingTimers.get(sessionId);
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimers.delete(sessionId);
  activeSockets.delete(sessionId);

  let clean = true;
  try {
    if (sessionDir && fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[${sessionId}] Cleaned session directory`);
    }
  } catch (err) {
    console.error(`[${sessionId}] Error deleting session files:`, err.message);
    clean = false;
  }
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      console.log(`[${sessionId}] Cleaned uploaded image file`);
    }
  } catch (err) {
    console.error(`[${sessionId}] Error deleting uploaded image:`, err.message);
    clean = false;
  }
  return clean;
}

function clearPairingTimer(sessionId) {
  const timer = pairingTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  pairingTimers.delete(sessionId);
}

function closeSocket(sock) {
  try { sock?.ws?.close(); } catch (_) {}
  try { sock?.end?.(); } catch (_) {}
}

function logoutSocket(sock, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.ev.off("connection.update", onUpdate); } catch (_) {}
      resolve(confirmed);
    };
    const onUpdate = (update = {}) => {
      if (update.connection !== "close") return;
      let statusCode;
      try { statusCode = new Boom(update.lastDisconnect?.error).output?.statusCode; } catch (_) {}
      finish(statusCode === DisconnectReason?.loggedOut);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try { sock.ev.on("connection.update", onUpdate); } catch (_) {}
    Promise.resolve()
      .then(() => sock.logout("Full DP update complete"))
      .catch(() => finish(false));
  });
}

Router.get("/", async (req, res) => {
  if (!req.query.filename) return res.status(400).json({ error: "Filename is required" });
  if (!req.query.phoneNumber) return res.status(400).json({ error: "Phone number is required" });

  const filename = String(req.query.filename);
  if (
    path.basename(filename) !== filename ||
    !/^[a-z0-9_-]+\.(?:jpe?g|png|webp|gif|avif)$/i.test(filename)
  ) {
    return res.status(400).json({ error: "Invalid image filename" });
  }

  const sessionId = String(req.query.sessionId || `sess_${Date.now().toString(36)}`);
  if (!/^[a-z0-9_-]{8,128}$/i.test(sessionId)) {
    return res.status(400).json({ error: "Invalid session ID" });
  }

  const uploadsDir = path.resolve(__dirname, "../uploads");
  const imagePath = path.resolve(uploadsDir, filename);
  if (!imagePath.startsWith(`${uploadsDir}${path.sep}`)) {
    return res.status(400).json({ error: "Invalid image filename" });
  }
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: "Image file not found on server" });
  }

  const rawNumber = sanitizeNumber(req.query.phoneNumber);
  if (!rawNumber || rawNumber.length < 9) {
    return res.status(400).json({ error: "Invalid phone number. Include your country code." });
  }

  const sessionsDir = path.resolve(__dirname, "../sessions");
  const sessionDir = path.resolve(sessionsDir, sessionId);
  if (!sessionDir.startsWith(`${sessionsDir}${path.sep}`)) {
    return res.status(400).json({ error: "Invalid session ID" });
  }
  if (sessionStatus.has(sessionId) || fs.existsSync(sessionDir)) {
    return res.status(409).json({ error: "Session ID is already in use" });
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  sessionStatus.set(sessionId, {
    status: "connecting",
    step: 1,
    message: "Connecting to WhatsApp servers..."
  });

  try {
    await loadBaileys();
    const version = await getWAVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const startSocket = async (isRestart = false) => {
      const authState = isRestart ? (await useMultiFileAuthState(sessionDir)).state : state;
      const credsSaver = isRestart ? (await useMultiFileAuthState(sessionDir)).saveCreds : saveCreds;

      const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: authState,
        ...(version ? { version } : {}),
        browser: ["Mac OS", "Chrome", "121.0.6167.85"],
        shouldSyncHistoryMessage: () => false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 45000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false
      });
      activeSockets.set(sessionId, sock);

      const safeSaveCreds = async () => {
        try {
          const status = sessionStatus.get(sessionId)?.status;
          if (!["error", "logging_out", "logged_out", "clearing", "completed"].includes(status) && fs.existsSync(sessionDir)) {
            await credsSaver();
          }
        } catch (_) {}
      };
      sock.ev.on("creds.update", safeSaveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
          console.log(`[${sessionId}] Connection closed with code:`, statusCode);

          if (statusCode === DisconnectReason.loggedOut) {
            const loggingOut = ["logging_out", "clearing", "completed"].includes(sessionStatus.get(sessionId)?.status);
            sessionStatus.set(sessionId, {
              status: loggingOut ? "logged_out" : "error",
              step: loggingOut ? 6 : 7,
              message: loggingOut
                ? "Logged out from WhatsApp."
                : "WhatsApp closed the session before the profile-picture update finished. Please pair again."
            });
            cleanupSession(sessionId, sessionDir, imagePath);
          } else if (statusCode === DisconnectReason.restartRequired) {
            console.log(`[${sessionId}] Restart required (code 515) — reconnecting...`);
            sessionStatus.set(sessionId, {
              status: "restarting",
              step: 2,
              message: "Device recognized! Completing link handshake..."
            });
            await (delay ? delay(1500) : new Promise((r) => setTimeout(r, 1500)));
            startSocket(true);
          } else if (!["error", "logging_out", "logged_out", "clearing", "completed"].includes(sessionStatus.get(sessionId)?.status)) {
            sessionStatus.set(sessionId, {
              status: "error",
              step: 7,
              message: "WhatsApp connection closed before the update finished. Please pair again."
            });
            cleanupSession(sessionId, sessionDir, imagePath);
          }
        } else if (connection === "open") {
          clearPairingTimer(sessionId);
          if (["error", "logging_out", "logged_out", "clearing", "completed"].includes(sessionStatus.get(sessionId)?.status)) {
            return;
          }
          console.log(`[${sessionId}] WhatsApp linked successfully`);
          sessionStatus.set(sessionId, {
            status: "linked",
            step: 3,
            message: "WhatsApp linked! Generating full-screen DP..."
          });

          await (delay ? delay(600) : new Promise((r) => setTimeout(r, 600)));

          let dpError = null;
          try {
            if (!fs.existsSync(imagePath)) {
              throw new Error("Image not found for DP upload");
            }

            const imageBuffer = fs.readFileSync(imagePath);
            sessionStatus.set(sessionId, {
              status: "uploading_dp",
              step: 4,
              message: "Uploading full-screen profile picture..."
            });

            let dpUploaded = false;
            let lastUploadErr = null;

            // Levanter Sharp pipeline (fit: inside, chromaSubsampling 4:4:4, quality 100)
            for (const size of [720, 640, 500]) {
              try {
                const { img: imgBuf } = await generateProfilePicture(imageBuffer, size, size, 100);
                await sock.query({
                  tag: "iq",
                  attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
                  content: [{ tag: "picture", attrs: { type: "image" }, content: imgBuf }]
                });
                dpUploaded = true;
                break;
              } catch (upErr) {
                lastUploadErr = upErr;
                console.warn("[" + sessionId + "] Upload at " + size + "px with sharp returned:", upErr?.message || upErr);
              }
            }

            if (!dpUploaded) {
              throw lastUploadErr || new Error("WhatsApp rejected profile picture upload");
            }

            await (delay ? delay(600) : new Promise((r) => setTimeout(r, 600)));
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
            dpError = err;
          }

          await (delay ? delay(1000) : new Promise((r) => setTimeout(r, 1000)));
          sessionStatus.set(sessionId, {
            status: "logging_out",
            step: 6,
            message: "Logging out from WhatsApp..."
          });

          const logoutConfirmed = await logoutSocket(sock, 10000);
          closeSocket(sock);

          sessionStatus.set(sessionId, {
            status: "clearing",
            step: 7,
            message: "Removing local session and uploaded image..."
          });

          const cleanupSucceeded = cleanupSession(sessionId, sessionDir, imagePath);

          if (!logoutConfirmed) {
            sessionStatus.set(sessionId, {
              status: "error",
              step: 7,
              message: `${dpError ? "The profile-picture update failed. " : ""}WhatsApp did not confirm logout. Local session files were removed; check Linked Devices in WhatsApp and remove this session if it is still listed.${dpError ? ` Update error: ${dpError.message || dpError}` : ""}`
            });
          } else if (!cleanupSucceeded) {
            sessionStatus.set(sessionId, {
              status: "error",
              step: 7,
              message: "WhatsApp logout was confirmed, but local cleanup failed. Please retry cleanup."
            });
          } else if (dpError) {
            sessionStatus.set(sessionId, {
              status: "error",
              step: 7,
              message: `Profile-picture update failed, but WhatsApp logout and local cleanup completed. ${dpError.message || dpError}`
            });
          } else {
            sessionStatus.set(sessionId, {
              status: "completed",
              step: 8,
              message: "Complete! WhatsApp confirmed logout and local files were cleaned. ✅"
            });
          }
        }
      });

      return sock;
    };

    const initialSock = await startSocket(false);

    const isReady = await waitForSocketOpen(initialSock, 20000);
    if (!isReady) {
      sessionStatus.set(sessionId, {
        status: "error",
        step: 7,
        message: "Connection to WhatsApp timed out. Please try again."
      });
      closeSocket(activeSockets.get(sessionId));
      cleanupSession(sessionId, sessionDir, imagePath);
      if (!res.headersSent) {
        return res.status(504).json({ error: "Could not reach WhatsApp servers. Please retry." });
      }
      return;
    }

    await (delay ? delay(500) : new Promise((r) => setTimeout(r, 500)));

    const MAX_CODE_ATTEMPTS = 4;
    let pairingCode = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      const statusBeforeRequest = sessionStatus.get(sessionId)?.status;
      if (["linked", "uploading_dp", "dp_done", "logging_out", "logged_out", "clearing", "completed", "error"].includes(statusBeforeRequest)) {
        break;
      }
      try {
        const currentStatus = sessionStatus.get(sessionId)?.status;
        if (!["linked", "uploading_dp", "dp_done", "logging_out", "logged_out", "clearing", "completed", "error"].includes(currentStatus)) {
          sessionStatus.set(sessionId, {
            status: "requesting_code",
            step: 1,
            message: `Requesting pairing code (attempt ${attempt})...`
          });
        }

        let code = await initialSock.requestPairingCode(rawNumber);
        if (code) {
          pairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[${sessionId}] Pair request attempt ${attempt} failed: ${err.message}`);
        const retryDelay = Math.min(1500 * (2 ** Math.min(attempt - 1, 3)), 6000);
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }

    if (!pairingCode) {
      const statusAfterRequest = sessionStatus.get(sessionId)?.status;
      if (["linked", "uploading_dp", "dp_done", "logging_out", "logged_out", "clearing", "completed"].includes(statusAfterRequest)) {
        if (!res.headersSent) {
          return res.status(200).json({ sessionId, phoneNumber: rawNumber });
        }
        return;
      }
      const errMsg = lastError?.message
        ? `WhatsApp did not issue a pairing code (${lastError.message}). Please try again.`
        : "WhatsApp did not return a pairing code";
      sessionStatus.set(sessionId, { status: "error", step: 7, message: errMsg });
      closeSocket(activeSockets.get(sessionId));
      cleanupSession(sessionId, sessionDir, imagePath);
      if (!res.headersSent) return res.status(500).json({ error: errMsg });
      return;
    }

    const currentStatus = sessionStatus.get(sessionId) || {};
    if (["connecting", "requesting_code", "restarting", "waiting_link"].includes(currentStatus.status)) {
      sessionStatus.set(sessionId, {
        ...currentStatus,
        status: "waiting_link",
        step: 2,
        code: pairingCode,
        message: "Pairing code ready! Check WhatsApp notification on your phone or enter in Linked Devices."
      });

      const timer = setTimeout(() => {
        const latest = sessionStatus.get(sessionId);
        if (!["waiting_link", "restarting"].includes(latest?.status)) return;
        sessionStatus.set(sessionId, {
          status: "error",
          step: 7,
          message: "Pairing timed out before WhatsApp linked. Generate a new code and try again."
        });
        closeSocket(activeSockets.get(sessionId));
        cleanupSession(sessionId, sessionDir, imagePath);
      }, PAIRING_TIMEOUT_MS);
      pairingTimers.set(sessionId, timer);
    } else {
      // The connection may finish while the pairing-code request is returning.
      // Preserve its current stage instead of resetting the UI to "waiting".
      sessionStatus.set(sessionId, { ...currentStatus, code: pairingCode });
    }

    if (!res.headersSent) {
      return res.status(200).json({
        code: pairingCode,
        sessionId: sessionId,
        phoneNumber: rawNumber
      });
    }

  } catch (err) {
    console.error(`[${sessionId}] Fatal error:`, err);
    sessionStatus.set(sessionId, { status: "error", step: 7, message: err.message });
    closeSocket(activeSockets.get(sessionId));
    cleanupSession(sessionId, sessionDir, imagePath);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to initialize pairing", details: err.message });
    }
  }
});

module.exports = Router;
