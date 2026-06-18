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
    getConnectionStatus
} = require("./whatsapp/whatsapp");

app.use("/api/whatsapp", whatsappRoutes);

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "WhatsApp Service",
        status: "running"
    });
});

function hasValidAuth() {
    try {
        const credsPath = "./auth_info/creds.json";

        if (!fs.existsSync(credsPath)) return false;

        const content = fs.readFileSync(credsPath, "utf-8").trim();

        if (!content || content === "{}") return false;

        const parsed = JSON.parse(content);

        // Must have actual keys inside
        return Object.keys(parsed).length > 0;

    } catch (err) {
        console.log("Auth check failed:", err.message);
        return false;
    }
}
const path=require("path")
app.use(express.static(path.join(__dirname,"frontend/dist")))
app.get("*",(req,res)=>{
    if(!req.path.startsWith("/api")){
        res.sendFile(path.join(__dirname,"frontend/dist/index.html"))
    }
})

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
