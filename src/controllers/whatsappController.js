const {
    getSocket,
    getConnectionStatus,
    connectWhatsApp,
    generateQr,
    hasValidAuth
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

module.exports = {
    sendMessage,
    getStatus,
    getQr,
    reconnectWhatsapp,
    generateQrController
};
