const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    Browsers
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");
const nodemailer = require("nodemailer");

const store = {
    chats: {},
    messages: {},
    contacts: {},
    jidMap: {},

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

    getPhoneJid(jid) {
        if (!jid) return "";
        if (jid.endsWith("@s.whatsapp.net")) return jid;
        if (this.jidMap && this.jidMap[jid]) return this.jidMap[jid];
        
        // Scan messages for alternate JID containing the phone number
        const msgs = this.messages[jid];
        if (Array.isArray(msgs)) {
            for (const msg of msgs) {
                if (msg?.key?.remoteJidAlt) {
                    this.jidMap[jid] = msg.key.remoteJidAlt;
                    return msg.key.remoteJidAlt;
                }
            }
        }
        return "";
    },

    writeToFile(filePath) {
        try {
            fs.writeFileSync(filePath, JSON.stringify({
                chats: this.chats,
                messages: this.messages,
                contacts: this.contacts,
                jidMap: this.jidMap
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
                this.contacts = data.contacts || {};
                this.jidMap = data.jidMap || {};

                // Reconstruct alternate JID links (e.g. lid vs s.whatsapp.net phone number)
                for (const jid of Object.keys(this.messages)) {
                    const msgs = this.messages[jid];
                    if (Array.isArray(msgs)) {
                        for (const msg of msgs) {
                            if (msg?.key?.remoteJidAlt) {
                                const altJid = msg.key.remoteJidAlt;
                                
                                // Record in JID Map
                                this.jidMap[jid] = altJid;
                                this.jidMap[altJid] = jid;

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
let reconnectTimer = null;

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
        if (sock?.authState?.creds?.me?.id) return true;
        const credsPath = path.resolve("./auth_info/creds.json");
        if (!fs.existsSync(credsPath)) return false;
        const content = fs.readFileSync(credsPath, "utf-8").trim();
        if (!content || content === "{}") return false;
        const parsed = JSON.parse(content);
        return Boolean(parsed.me && parsed.me.id);
    } catch (err) {
        console.error("hasValidAuth check error:", err.message);
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
            fs.mkdirSync("./auth_info", { recursive: true });
            return;
        }
        const files = fs.readdirSync("./auth_info");
        for (const file of files) {
            if (file === "store.json") continue; // Preserve cached chat store
            try {
                fs.unlinkSync(`./auth_info/${file}`);
            } catch (e) {
                console.warn(`Failed to remove ./auth_info/${file}:`, e.message);
            }
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

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Clean up existing socket if present
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
            sock.ws?.close();
        } catch (e) {
            console.warn("Cleanup existing socket in generateQr:", e.message);
        }
        sock = null;
    }

    // Clear broken/old auth so Baileys shows fresh QR
    clearAuthInfo();

    // Reset state
    connectionStatus.connected = false;
    connectionStatus.qr = null;
    connectionStatus.reAuthRequired = true;
    connectionStatus.state = "REAUTH_REQUIRED";
    connectionStatus.error = null;
    reconnectAttempts = 0;
    isConnecting = false; // Reset so connectWhatsApp can proceed

    await connectWhatsApp();
}

// ─── Main Connect ─────────────────────────────────────────────────────────────

async function connectWhatsApp() {

    if (isConnecting) {
        console.log("Connection already in progress");
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        isConnecting = true;
        connectionStatus.state = "CONNECTING";

        // Clean up previous socket if it exists
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
                sock.ws?.close();
            } catch (e) {
                console.warn("Cleanup existing socket before connect:", e.message);
            }
            sock = null;
        }

        const { state, saveCreds } =
            await useMultiFileAuthState("auth_info");

        let version = [2, 3000, 1047441584]; // modern default fallback
        try {
            const { version: fetchedVersion } = await fetchLatestWaWebVersion();
            version = fetchedVersion;
            console.log(`Using WhatsApp Web version: ${version.join(".")}`);
        } catch (err) {
            try {
                const { version: fetchedVersion } = await fetchLatestBaileysVersion();
                version = fetchedVersion;
                console.log(`Using Baileys fallback version: ${version.join(".")}`);
            } catch (e) {
                console.warn("Using default fallback version:", version.join("."));
            }
        }

        sock = makeWASocket({
            auth: state,
            version,
            logger: P({ level: "silent" }),
            browser: Browsers.windows("Desktop"),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            qrTimeout: 40000
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

        sock.ev.on("contacts.upsert", (newContacts) => {
            for (const contact of newContacts) {
                if (!store.contacts[contact.id]) {
                    store.contacts[contact.id] = contact;
                } else {
                    Object.assign(store.contacts[contact.id], contact);
                }
            }
        });

        sock.ev.on("contacts.update", (contactUpdates) => {
            for (const update of contactUpdates) {
                if (store.contacts[update.id]) {
                    Object.assign(store.contacts[update.id], update);
                } else {
                    store.contacts[update.id] = update;
                }
            }
        });

        sock.ev.on("messaging-history.set", ({ chats: syncedChats, messages: syncedMessages, contacts: syncedContacts }) => {
            if (Array.isArray(syncedContacts)) {
                for (const contact of syncedContacts) {
                    if (!store.contacts[contact.id]) {
                        store.contacts[contact.id] = contact;
                    } else {
                        Object.assign(store.contacts[contact.id], contact);
                    }
                }
            }

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
                        // Record JID mapping
                        store.jidMap[jid] = altJid;
                        store.jidMap[altJid] = jid;

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
                    // Record JID mapping
                    store.jidMap[jid] = altJid;
                    store.jidMap[altJid] = jid;

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
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
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

                const wasConnected = connectionStatus.connected;
                const reason = lastDisconnect?.error?.output?.statusCode;
                const fullError = lastDisconnect?.error;

                console.log(`❌ Closed. Reason: ${reason}`);

                connectionStatus.connected = false;
                connectionStatus.lastDisconnectAt = new Date().toISOString();
                connectionStatus.lastDisconnectReason = reason;
                connectionStatus.lastDisconnectMessage = fullError?.message || null;
                connectionStatus.error = fullError?.message || `Disconnected (${reason})`;

                // Send email alert only if the bot was actively connected beforehand
                if (wasConnected) {
                    await sendDisconnectEmail(reason || "Unknown status code");
                }

                // WhatsApp stream restart required (code 515) - normal part of pairing handshake
                if (reason === DisconnectReason.restartRequired) {
                    console.log("Stream restart required by WhatsApp (515). Reconnecting immediately...");
                    connectionStatus.state = "CONNECTING";
                    reconnectTimer = setTimeout(async () => {
                        await connectWhatsApp();
                    }, 500);
                    return;
                }

                // Needs full re-login (logged out / forbidden)
                if (requiresReAuth(reason)) {
                    connectionStatus.reAuthRequired = true;
                    connectionStatus.state = "REAUTH_REQUIRED";
                    connectionStatus.qr = null;
                    clearAuthInfo();
                    console.log("Session expired or logged out. QR scan required.");
                    await notifyReAuthRequired(reason);
                    return;
                }

                // QR timeout while waiting for scan
                if (reason === DisconnectReason.timedOut && !hasValidAuth()) {
                    console.log("QR timeout without scan. Waiting for fresh QR request.");
                    connectionStatus.reAuthRequired = true;
                    connectionStatus.state = "REAUTH_REQUIRED";
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
                    reconnectTimer = setTimeout(async () => {
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