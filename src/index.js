require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const whatsappRoutes = require("./routes/whatsappRoutes");

const {
    connectWhatsApp,
    getConnectionStatus,
    hasValidAuth
} = require("./whatsapp/whatsapp");

app.use("/api/whatsapp", whatsappRoutes);

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        service: "WhatsApp Service",
        status: "running"
    });
});

const path = require("path");
app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.get("/{*splat}", (req, res) => {
    if (!req.path.startsWith("/api")) {
        res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
    } else {
        res.status(404).json({
            success: false,
            message: "API endpoint not found"
        });
    }
});

const PORT=process.env.PORT||3000;
app.listen(PORT, async () => {
    console.log("Server running on 3000");

    if (hasValidAuth()) {
        console.log("Valid auth found. Connecting...");
        await connectWhatsApp();
    } else {
        console.log("No valid auth found. Waiting for QR generation.");
        const status = getConnectionStatus();
        status.state = "REAUTH_REQUIRED";
        status.reAuthRequired = true;
    }
});