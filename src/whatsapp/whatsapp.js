const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");
const nodemailer = require("nodemailer");

const store = {
    chats: {},
    messages: {},

    getUnreadChats() {
        const uniqueChats = {};
        for (const chat of Object.values(this.chats)) {
            if (chat && chat.id) {
                uniqueChats[chat.id] = chat;
            }
        }
        return Object.values(uniqueChats).filter(chat => (chat.unreadCount || 0) > 0);
    },

    getMessages(jid, count = 50) {
        const msgs = this.messages[jid] || [];
        return msgs.slice(-count);
    },

    writeToFile(filePath) {
        try {
            fs.writeFileSync(filePath, JSON.stringify({
                chats: this.chats,
                messages: this.messages
            }, null, 2), "utf-8");
        } catch (err) {
            console.error("Failed to write store to file:", err.message);
        }
    },

    readFromFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
                this.chats = data.chats || {};
                this.messages = data.messages || {};

                // Reconstruct alternate JID links (e.g. lid vs s.whatsapp.net phone number)
                for (const jid of Object.keys(this.messages)) {
                    const msgs = this.messages[jid];
                    if (Array.isArray(msgs)) {
                        for (const msg of msgs) {
                            if (msg?.key?.remoteJidAlt) {
                                const altJid = msg.key.remoteJidAlt;
                                
                                // Merge message histories if they are separate arrays
                                if (this.messages[altJid] !== this.messages[jid]) {
                                    const merged = [...(this.messages[jid] || []), ...(this.messages[altJid] || [])];
                                    const unique = [];
                                    const seenIds = new Set();
                                    for (const m of merged) {
                                        if (m?.key?.id && !seenIds.has(m.key.id)) {
                                            seenIds.add(m.key.id);
                                            unique.push(m);
                                        }
                                    }
                                    this.messages[jid] = unique;
                                    this.messages[altJid] = unique;
                                }

                                // Merge chat objects if they are separate
                                if (this.chats[jid] !== this.chats[altJid]) {
                                    const mergedChat = {
                                        ...(this.chats[jid] || {}),
                                        ...(this.chats[altJid] || {})
                                    };
                                    mergedChat.unreadCount = Math.max(
                                        this.chats[jid]?.unreadCount || 0,
                                        this.chats[altJid]?.unreadCount || 0
                                    );
                                    this.chats[jid] = mergedChat;
                                    this.chats[altJid] = mergedChat;
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Failed to read store from file:", err.message);
        }
    }
};

const storePath = "./auth_info/store.json";

try {
    if (fs.existsSync(storePath)) {
        store.readFromFile(storePath);
        console.log("Successfully loaded cached chats from store.");
    }
} catch (err) {
    console.error("Error reading store from file:", err.message);
}

// Auto-save store every 10 seconds
setInterval(() => {
    try {
        store.writeToFile(storePath);
    } catch (err) {
        console.error("Error writing store to file:", err.message);
    }
}, 10000);

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
        403,
        405 // Method Not Allowed / Connection Failure
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

// ─── Send Disconnect Email ───────────────────────────────────────────────────

async function sendDisconnectEmail(reason) {
    const recipient = "sahil.teotia@steadyrabbit.in";
    
    // Check if SMTP config is present
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("SMTP environment variables are not configured. Skipping disconnect email alert.");
        return;
    }

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mailOptions = {
            from: `"WhatsApp Bot Alert" <${process.env.SMTP_USER}>`,
            to: recipient,
            subject: "⚠️ WhatsApp Bot Disconnected",
            text: `The WhatsApp bot has disconnected.\n\nReason/Status Code: ${reason}\nTimestamp: ${new Date().toLocaleString()}\n\nPlease visit the dashboard to reconnect or generate a new QR code.`,
            html: `<p>The WhatsApp bot has disconnected.</p>
                   <p><strong>Reason/Status Code:</strong> ${reason}</p>
                   <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                   <p>Please visit the dashboard to reconnect or generate a new QR code.</p>`
        };

        const info = await transporter.sendMail(mailOptions);
        console.log("Disconnect email successfully sent to", recipient, ":", info.messageId);
    } catch (err) {
        console.error("Failed to send disconnect email:", err.message);
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

        let version = [2, 3000, 1015901307]; // fallback default
        try {
            const { version: fetchedVersion } = await fetchLatestBaileysVersion();
            version = fetchedVersion;
            console.log(`Using WhatsApp Web version: ${version.join(".")}`);
        } catch (err) {
            console.warn("Failed to fetch latest Baileys version, using default fallback:", err.message);
        }

        sock = makeWASocket({
            auth: state,
            version,
            logger: P({ level: "silent" }),
            browser: ["Chrome", "Windows", "10"],
            markOnlineOnConnect: false,
            syncFullHistory: true,
            shouldSyncHistoryMessage: () => true
        });

        // Bind custom store events
        sock.ev.on("chats.upsert", (newChats) => {
            for (const chat of newChats) {
                if (!store.chats[chat.id]) {
                    store.chats[chat.id] = { id: chat.id, unreadCount: 0, ...chat };
                } else {
                    Object.assign(store.chats[chat.id], chat);
                }
            }
        });

        sock.ev.on("chats.update", (chatUpdates) => {
            for (const update of chatUpdates) {
                if (store.chats[update.id]) {
                    Object.assign(store.chats[update.id], update);
                } else {
                    store.chats[update.id] = { id: update.id, unreadCount: 0, ...update };
                }
            }
        });

        sock.ev.on("chats.set", ({ chats: newChats }) => {
            for (const chat of newChats) {
                store.chats[chat.id] = { id: chat.id, unreadCount: 0, ...chat };
            }
        });

        sock.ev.on("chats.delete", (deletedJids) => {
            for (const jid of deletedJids) {
                delete store.chats[jid];
                delete store.messages[jid];
            }
        });

        sock.ev.on("messaging-history.set", ({ chats: syncedChats, messages: syncedMessages }) => {
            if (Array.isArray(syncedChats)) {
                for (const chat of syncedChats) {
                    if (!store.chats[chat.id]) {
                        store.chats[chat.id] = { id: chat.id, unreadCount: 0, ...chat };
                    } else {
                        Object.assign(store.chats[chat.id], chat);
                    }
                }
            }

            if (Array.isArray(syncedMessages)) {
                for (const msg of syncedMessages) {
                    const jid = msg.key.remoteJid;
                    if (!jid) continue;

                    if (!store.messages[jid]) {
                        if (msg.key.remoteJidAlt && store.messages[msg.key.remoteJidAlt]) {
                            store.messages[jid] = store.messages[msg.key.remoteJidAlt];
                        } else {
                            store.messages[jid] = [];
                        }
                    }
                    
                    const exists = store.messages[jid].some(m => m.key.id === msg.key.id);
                    if (!exists) {
                        store.messages[jid].push(msg);
                    }

                    if (msg.key.remoteJidAlt) {
                        const altJid = msg.key.remoteJidAlt;
                        if (!store.messages[altJid]) {
                            store.messages[altJid] = store.messages[jid];
                        }
                    }
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);

        // ── Incoming Messages ──────────────────────────────────────────────
        sock.ev.on("messages.upsert", async ({ messages, type }) => {

            for (const msg of messages) {
                const jid = msg.key.remoteJid;
                if (!jid) continue;

                // Cache the message in our custom store
                if (!store.messages[jid]) {
                    if (msg.key.remoteJidAlt && store.messages[msg.key.remoteJidAlt]) {
                        store.messages[jid] = store.messages[msg.key.remoteJidAlt];
                    } else {
                        store.messages[jid] = [];
                    }
                }
                store.messages[jid].push(msg);

                // Link alternate JID to reference the same array, merging any existing history
                if (msg.key.remoteJidAlt) {
                    const altJid = msg.key.remoteJidAlt;
                    if (store.messages[altJid] !== store.messages[jid]) {
                        const merged = [...(store.messages[jid] || []), ...(store.messages[altJid] || [])];
                        const unique = [];
                        const seenIds = new Set();
                        for (const m of merged) {
                            if (m?.key?.id && !seenIds.has(m.key.id)) {
                                seenIds.add(m.key.id);
                                unique.push(m);
                            }
                        }
                        store.messages[jid] = unique;
                        store.messages[altJid] = unique;
                    }
                }

                // Keep only last 100 messages per chat to prevent unbounded memory growth
                if (store.messages[jid].length > 100) {
                    store.messages[jid].shift();
                }

                // If not sent by me, increment unread count for the chat
                if (!msg.key.fromMe && type === "notify") {
                    if (!store.chats[jid]) {
                        store.chats[jid] = { id: jid, unreadCount: 0 };
                    }
                    store.chats[jid].unreadCount = (store.chats[jid].unreadCount || 0) + 1;

                    // Link alternate JID for the chat object, merging any existing properties
                    if (msg.key.remoteJidAlt) {
                        const altJid = msg.key.remoteJidAlt;
                        if (store.chats[altJid] !== store.chats[jid]) {
                            const mergedChat = {
                                ...(store.chats[jid] || {}),
                                ...(store.chats[altJid] || {})
                            };
                            mergedChat.unreadCount = Math.max(
                                store.chats[jid]?.unreadCount || 0,
                                store.chats[altJid]?.unreadCount || 0
                            );
                            store.chats[jid] = mergedChat;
                            store.chats[altJid] = mergedChat;
                        }
                    }
                }
            }

            if (type !== "notify") return;

            const msg = messages[0];
            if (!msg?.message) return;
            if (msg.key.fromMe) return;

                        const chatId = msg.key.remoteJid;

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            let phone = chatId.split("@")[0];
            if (chatId.endsWith("@lid") && msg.key.remoteJidAlt) {
                phone = msg.key.remoteJidAlt.split("@")[0];
            }

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

                // Send email alert on disconnect
                await sendDisconnectEmail(reason || "Unknown status code");

                // Needs full re-login
                if (requiresReAuth(reason)) {
                    connectionStatus.reAuthRequired = true;
                    connectionStatus.state = "REAUTH_REQUIRED";
                    connectionStatus.qr = null;
                    console.log("Session expired. QR scan required.");
                    await notifyReAuthRequired(reason);
                    return;
                }

                // Auth exists — check if reconnect limits reached
                if (hasValidAuth()) {
                    if (reconnectAttempts >= 10) {
                        console.log("Reconnection attempts limit reached (10). Requiring re-auth...");
                        connectionStatus.reAuthRequired = true;
                        connectionStatus.state = "REAUTH_REQUIRED";
                        connectionStatus.qr = null;
                        connectionStatus.error = "Max reconnect attempts (10) exceeded. Re-auth required.";
                        clearAuthInfo();
                        await notifyReAuthRequired(reason || "Max reconnect attempts exceeded");
                        return;
                    }

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
    hasValidAuth,
    store
};