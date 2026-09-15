const fs = require("fs");
const path = require("path");
const {
    getSocket,
    getConnectionStatus,
    connectWhatsApp,
    generateQr,
    hasValidAuth,
    store
} = require("../whatsapp/whatsapp");

// ─── Generate QR ──────────────────────────────────────────────────────────────

async function generateQrController(req, res) {
    try {
        await generateQr();
        res.json({
            success: true,
            message: "QR generation started"
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Send Message ─────────────────────────────────────────────────────────────

async function sendMessage(req, res) {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                message: "phone and message are required"
            });
        }

        let status = getConnectionStatus();

        if (!status.connected) {

            // No valid auth at all — tell n8n to trigger reauth
            if (!hasValidAuth()) {
                return res.status(401).json({
                    success: false,
                    message: "WhatsApp not connected. ReAuth required.",
                    state: "REAUTH_REQUIRED",
                    reAuthRequired: true
                });
            }

            // Auth exists — try reconnecting
            console.log("WhatsApp not connected. Trying reconnect...");
            await connectWhatsApp();

            await new Promise(resolve => setTimeout(resolve, 5000));

            status = getConnectionStatus();

            if (!status.connected) {
                return res.status(503).json({
                    success: false,
                    message: "WhatsApp is not connected. Reconnect in progress.",
                    state: status.state,
                    reAuthRequired: status.reAuthRequired
                });
            }
        }

        const sock = getSocket();

        const numberCheck = await sock.onWhatsApp(phone);

        if (!numberCheck || numberCheck.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Number not registered on WhatsApp"
            });
        }

        const jid = numberCheck[0].jid;

        const result = await sock.sendMessage(jid, { text: message });

        res.json({
            success: true,
            exists: true,
            chatId: result.key.remoteJid,
            messageId: result.key.id
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Get Status ───────────────────────────────────────────────────────────────

async function getStatus(req, res) {
    try {
        const status = getConnectionStatus();
        res.json({
            success: true,
            data: status
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Get QR ───────────────────────────────────────────────────────────────────

async function getQr(req, res) {
    try {
        const status = getConnectionStatus();
        res.json({
            success: true,
            connected: status.connected,
            qr: status.qr
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

async function reconnectWhatsapp(req, res) {
    try {
        const status = getConnectionStatus();

        if (status.connected) {
            return res.json({
                success: true,
                message: "Already connected"
            });
        }

        if (!hasValidAuth()) {
            return res.status(401).json({
                success: false,
                message: "No valid auth. QR scan required.",
                reAuthRequired: true
            });
        }

        await connectWhatsApp();

        res.json({
            success: true,
            message: "Reconnect initiated"
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Get Unread Chats ────────────────────────────────────────────────────────

async function getUnreadChats(req, res) {
    try {
        const unreadChats = store.getUnreadChats();
        
        const formatted = unreadChats.map(chat => {
            const rawMessages = store.getMessages(chat.id, 100);
            
            // Format the messages
            const formattedMessages = rawMessages
                .map(formatMessage)
                .filter(m => m !== null && m.text.trim() !== "");
                
            // Sort messages in descending order (newest first)
            formattedMessages.sort((a, b) => {
                const tA = getTimestampSeconds(a.rawTimestamp);
                const tB = getTimestampSeconds(b.rawTimestamp);
                return tB - tA;
            });

            // Resolve alternate JID
            let remoteJidAlt = store.getPhoneJid(chat.id) || "";
            
            // Resolve contact name from the contacts database
            let senderName = getContactName(chat.id, remoteJidAlt) || chat.name || "";
            if (!senderName && rawMessages.length > 0) {
                const withPush = rawMessages.find(m => m.pushName);
                if (withPush) {
                    senderName = withPush.pushName;
                }
            }
            
            let phoneJid = remoteJidAlt || chat.id || "";
            let phone = phoneJid.split("@")[0];

            return {
                chatId: chat.id,
                remoteJidAlt,
                phone,
                unreadCount: chat.unreadCount || 0,
                senderName: senderName || "Contact",
                messages: formattedMessages
            };
        });

        res.json({
            success: true,
            data: formatted
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Get Messages for a JID/Phone ───────────────────────────────────────────

// Helper to parse Unix timestamp from Baileys which can be a number, string, or Protobuf Long object
function getTimestampSeconds(timestamp) {
    if (!timestamp) return 0;
    if (typeof timestamp === "object") {
        return typeof timestamp.low === "number" ? timestamp.low : 0;
    }
    return parseInt(timestamp, 10) || 0;
}

// Helper to retrieve contact name from cached contacts
function getContactName(jid, altJid) {
    if (!store.contacts) return "";
    const contact = store.contacts[jid] || (altJid && store.contacts[altJid]) || {};
    return contact.name || contact.verifiedName || contact.notify || "";
}

// Helper to format raw Baileys messages into clean, readable objects
function formatMessage(msg) {
    if (!msg) return null;
    
    // Extract text from various message structures
    let text = "";
    if (msg.message) {
        text = msg.message.conversation ||
               msg.message.extendedTextMessage?.text ||
               msg.message.imageMessage?.caption ||
               msg.message.videoMessage?.caption ||
               "";
    }
    
    // Convert Unix timestamp to human-readable local time
    let readableTime = "";
    const seconds = getTimestampSeconds(msg.messageTimestamp);
    if (seconds > 0) {
        readableTime = new Date(seconds * 1000).toLocaleString();
    }
    
    const fromMe = msg.key?.fromMe ?? false;
    let phoneJid = store.getPhoneJid(msg.key?.remoteJid) || msg.key?.remoteJidAlt || msg.key?.remoteJid || "";
    let phone = phoneJid.split("@")[0];

    let sender = "Contact";
    if (fromMe) {
        sender = "Me";
    } else {
        sender = getContactName(msg.key?.remoteJid, phoneJid) || msg.pushName || "Contact";
    }
    
    return {
        messageId: msg.key?.id || "",
        fromMe,
        sender,
        phone,
        text,
        timestamp: readableTime,
        rawTimestamp: msg.messageTimestamp
    };
}

async function getMessages(req, res) {
    try {
        const { jid, phone, format } = req.query;
        let targetJid = jid;
        
        if (!targetJid && phone) {
            targetJid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
        }
        
        if (!targetJid) {
            return res.status(400).json({
                success: false,
                message: "Either jid or phone is required"
            });
        }
        
        // Retrieve message history from the store
        const messages = store.getMessages(targetJid, 50); 
        
        // Return raw data if format=raw is queried
        if (format === "raw") {
            return res.json({
                success: true,
                data: messages
            });
        }
        
        // Format and filter to return only actual text messages
        const formatted = messages
            .map(formatMessage)
            .filter(m => m !== null && m.text.trim() !== "");
            
        // Sort in descending order (newest first)
        formatted.sort((a, b) => {
            const tA = getTimestampSeconds(a.rawTimestamp);
            const tB = getTimestampSeconds(b.rawTimestamp);
            return tB - tA;
        });

        res.json({
            success: true,
            data: formatted
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

// ─── Debug Auth & Volume Status ───────────────────────────────────────────────

async function debugAuth(req, res) {
    try {
        const cwd = process.cwd();
        const credsPath = path.resolve("./auth_info/creds.json");
        const authDir = path.resolve("./auth_info");
        const rootAuthDir = "/auth_info";
        let dirExists = fs.existsSync(authDir);
        let rootDirExists = fs.existsSync(rootAuthDir);
        let files = [];
        let rootFiles = [];
        let credsExists = fs.existsSync(credsPath);
        let credsError = null;
        let parsed = null;

        if (dirExists) {
            try {
                files = fs.readdirSync(authDir);
            } catch (e) {
                files = [e.message];
            }
        }

        if (rootDirExists) {
            try {
                rootFiles = fs.readdirSync(rootAuthDir);
            } catch (e) {
                rootFiles = [e.message];
            }
        }

        if (credsExists) {
            try {
                const content = fs.readFileSync(credsPath, "utf-8");
                parsed = JSON.parse(content);
            } catch (e) {
                credsError = e.message;
            }
        }

        res.json({
            success: true,
            cwd,
            authDir,
            credsPath,
            dirExists,
            totalFilesInAuthDir: files.length,
            sampleFilesInAuthDir: files.slice(0, 15),
            rootDirExists,
            sampleFilesInRootDir: rootFiles.slice(0, 15),
            credsExists,
            credsError,
            hasMe: Boolean(parsed?.me),
            meId: parsed?.me?.id || null,
            registered: parsed?.registered,
            validAuth: hasValidAuth()
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

module.exports = {
    sendMessage,
    getStatus,
    getQr,
    reconnectWhatsapp,
    generateQrController,
    getUnreadChats,
    getMessages,
    debugAuth
};
