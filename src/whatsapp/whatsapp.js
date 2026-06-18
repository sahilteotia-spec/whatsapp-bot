const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");

let sock = null;
let reconnectAttempts = 0;
let isConnecting = false;

const connectionStatus = {
    connected: false,
    reconnectAttempts: 0,
    qr: null,
    error: null,
    lastConnectedAt: null,
    lastDisconnectAt: null,
    lastDisconnectReason: null,
    lastDisconnectMessage: null,
    reAuthRequired: false,
    state: "DISCONNECTED"
};

// ─── Auth Validation ──────────────────────────────────────────────────────────

function hasValidAuth() {
    try {
        const credsPath = "./auth_info/creds.json";
        if (!fs.existsSync(credsPath)) return false;
        const content = fs.readFileSync(credsPath, "utf-8").trim();
        if (!content || content === "{}") return false;
        const parsed = JSON.parse(content);
        return Object.keys(parsed).length > 0;
    } catch {
        return false;
    }
}

function requiresReAuth(reason) {
    return [
        DisconnectReason.loggedOut,
        401,
        403
    ].includes(reason);
}

// ─── Clear auth_info folder ───────────────────────────────────────────────────

function clearAuthInfo() {
    try {
        if (!fs.existsSync("./auth_info")) {
            fs.mkdirSync("./auth_info");
            return;
        }
        const files = fs.readdirSync("./auth_info");
        for (const file of files) {
            fs.unlinkSync(`./auth_info/${file}`);
        }
        console.log("Auth info cleared.");
    } catch (err) {
        console.log("Auth clear error:", err.message);
    }
}

// ─── Notify n8n ReAuth Required ───────────────────────────────────────────────

async function notifyReAuthRequired(reason) {
    if (!process.env.N8N_ALERT_WEBHOOK) return;
    try {
        await axios.post(process.env.N8N_ALERT_WEBHOOK, {
            event: "REAUTH_REQUIRED",
            reason,
            timestamp: new Date().toISOString()
        });
        console.log("ReAuth alert sent to n8n");
    } catch (err) {
        console.error("Failed to send reauth alert:", err.message);
    }
}

// ─── Generate QR (called from controller) ────────────────────────────────────

async function generateQr() {
    console.log("Generating QR — clearing old auth...");

    // Clear broken/old auth so Baileys shows fresh QR
    clearAuthInfo();

    // Reset state
    connectionStatus.qr = null;
    connectionStatus.reAuthRequired = true;
    connectionStatus.state = "REAUTH_REQUIRED";
    connectionStatus.error = null;
    isConnecting = false; // Reset so connectWhatsApp can proceed

    await connectWhatsApp();
}

// ─── Main Connect ─────────────────────────────────────────────────────────────

async function connectWhatsApp() {

    if (isConnecting) {
        console.log("Connection already in progress");
        return;
    }

    try {
        isConnecting = true;
        connectionStatus.state = "CONNECTING";

        const { state, saveCreds } =
            await useMultiFileAuthState("auth_info");

        sock = makeWASocket({
            auth: state,
            logger: P({ level: "silent" }),
            browser: ["Chrome", "Windows", "10"],
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on("creds.update", saveCreds);

        // ── Incoming Messages ──────────────────────────────────────────────
        sock.ev.on("messages.upsert", async ({ messages, type }) => {

            if (type !== "notify") return;

            const msg = messages[0];
            if (!msg?.message) return;
            if (msg.key.fromMe) return;

            const chatId = msg.key.remoteJid;

            // Skip @lid messages — internal device IDs, not real phone numbers
            if (chatId.endsWith("@lid")) {
                console.log("Skipping @lid message");
                return;
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            const phone = chatId.split("@")[0];

            const payload = {
                senderName: msg.pushName || "",
                chatId,
                phone,
                messageId: msg.key.id,
                timestamp: msg.messageTimestamp,
                fromMe: msg.key.fromMe,
                text
            };

            console.log("Incoming Message:", payload);

            try {
                await axios.post(
                    process.env.N8N_INCOMING_WEBHOOK,
                    payload
                );
                console.log("Webhook sent successfully");
            } catch (error) {
                console.error("Webhook failed:", error.message);
                console.error("Status:", error.response?.status);
                console.error("Response:", error.response?.data);
            }
        });

        // ── Connection Updates ─────────────────────────────────────────────
        sock.ev.on("connection.update", async (update) => {

            const { connection, qr, lastDisconnect } = update;

            // QR received — store in status for frontend
            if (qr) {
                connectionStatus.qr = qr;
                connectionStatus.state = "QR_READY";
                console.log("New QR generated — available via /api/whatsapp/qr");
            }

            if (connection === "open") {
                reconnectAttempts = 0;
                connectionStatus.connected = true;
                connectionStatus.reconnectAttempts = 0;
                connectionStatus.error = null;
                connectionStatus.qr = null;
                connectionStatus.reAuthRequired = false;
                connectionStatus.state = "CONNECTED";
                connectionStatus.lastConnectedAt = new Date().toISOString();
                isConnecting = false;
                console.log("✅ WhatsApp Connected");
            }

            if (connection === "close") {
                isConnecting = false;

                // Guard — if already in reauth state, ignore further close events
                if (connectionStatus.state === "REAUTH_REQUIRED") {
                    console.log("Already in REAUTH_REQUIRED — ignoring close event.");
                    return;
                }

                const reason = lastDisconnect?.error?.output?.statusCode;
                const fullError = lastDisconnect?.error;

                console.log(`❌ Closed. Reason: ${reason}`);

                connectionStatus.connected = false;
                connectionStatus.lastDisconnectAt = new Date().toISOString();
                connectionStatus.lastDisconnectReason = reason;
                connectionStatus.lastDisconnectMessage = fullError?.message || null;
                connectionStatus.error = fullError?.message || `Disconnected (${reason})`;

                // Needs full re-login
                if (requiresReAuth(reason)) {
                    connectionStatus.reAuthRequired = true;
                    connectionStatus.state = "REAUTH_REQUIRED";
                    connectionStatus.qr = null;
                    console.log("Session expired. QR scan required.");
                    await notifyReAuthRequired(reason);
                    return;
                }

                // Auth exists — keep retrying indefinitely
                if (hasValidAuth()) {
                    reconnectAttempts++;
                    connectionStatus.reconnectAttempts = reconnectAttempts;
                    connectionStatus.state = "RECONNECTING";
                    console.log(`Reconnect attempt ${reconnectAttempts}...`);
                    setTimeout(async () => {
                        await connectWhatsApp();
                    }, 5000);
                } else {
                    // No valid auth
                    connectionStatus.reAuthRequired = true;
                    connectionStatus.state = "REAUTH_REQUIRED";
                    connectionStatus.qr = null;
                    console.log("No valid auth. QR required.");
                    await notifyReAuthRequired(reason);
                }
            }
        });

    } catch (error) {
        isConnecting = false;
        connectionStatus.connected = false;
        connectionStatus.error = error.message;
        connectionStatus.state = "DISCONNECTED";
        console.error("connectWhatsApp Error:", error);
    }
}

function getSocket() {
    return sock;
}

function getConnectionStatus() {
    return connectionStatus;
}

module.exports = {
    connectWhatsApp,
    getSocket,
    getConnectionStatus,
    generateQr,
    hasValidAuth
};