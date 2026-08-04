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
                
            // Sort messages in ascending order (oldest first)
            formattedMessages.sort((a, b) => (a.rawTimestamp || 0) - (b.rawTimestamp || 0));

            // Extract alternate JID and pushName
            let remoteJidAlt = "";
            let senderName = chat.name || "";
            if (rawMessages.length > 0) {
                const withAlt = rawMessages.find(m => m.key?.remoteJidAlt);
                if (withAlt) {
                    remoteJidAlt = withAlt.key.remoteJidAlt;
                }
                const withPush = rawMessages.find(m => m.pushName);
                if (withPush) {
                    senderName = senderName || withPush.pushName;
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
    if (msg.messageTimestamp) {
        const ts = parseInt(msg.messageTimestamp);
        if (!isNaN(ts)) {
            readableTime = new Date(ts * 1000).toLocaleString();
        }
    }
    
    const fromMe = msg.key?.fromMe ?? false;
    const sender = fromMe ? "Me" : (msg.pushName || "Contact");
    
    let phoneJid = msg.key?.remoteJidAlt || msg.key?.remoteJid || "";
    let phone = phoneJid.split("@")[0];
    
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
            
        // Sort in ascending order (oldest first)
        formatted.sort((a, b) => (a.rawTimestamp || 0) - (b.rawTimestamp || 0));

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

module.exports = {
    sendMessage,
    getStatus,
    getQr,
    reconnectWhatsapp,
    generateQrController,
    getUnreadChats,
    getMessages
};
