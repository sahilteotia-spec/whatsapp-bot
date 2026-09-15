const express = require("express");

const {
    sendMessage,
    getStatus,
    getQr,
    reconnectWhatsapp,
    generateQrController,
    getUnreadChats,
    getMessages,
    debugAuth
} = require("../controllers/whatsappController");

const router = express.Router();

router.post("/send", sendMessage);

router.get("/status", getStatus);

router.get("/qr", getQr);

router.get("/debug", debugAuth);

router.post("/reconnect", reconnectWhatsapp);

router.post(
    "/generate-qr",
    generateQrController
);

router.get("/unread", getUnreadChats);
router.get("/messages", getMessages);

module.exports = router;