import { useEffect, useState } from "react";
import axios from "axios";
import { QRCodeSVG } from "qrcode.react";

const API = "/api/whatsapp";

function App() {
  const [status, setStatus] = useState(null);
  const [qr, setQr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  // ── Poll status every 2s ──────────────────────────────────────────────────
  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  // ── Poll QR every 15s when in QR_READY or REAUTH state ───────────────────
  // This ensures expired QRs are replaced automatically
  useEffect(() => {
    if (!status) return;

    const needsQr =
      status.state === "QR_READY" ||
      status.reAuthRequired;

    if (!needsQr) {
      setQr(null);
      return;
    }

    loadQr();
    const interval = setInterval(loadQr, 15000);
    return () => clearInterval(interval);

  }, [status?.state, status?.reAuthRequired]);


 async function loadStatus() {
  try {
    const res = await axios.get(`${API}/status`);
    setStatus(res.data.data);
  } catch (err) {
    // Backend is down
    setStatus(prev => prev ? {
      ...prev,
      connected: false,
      state: "SERVER_OFFLINE",
      error: "Cannot reach backend server"
    } : null);
  }
}

  async function loadQr() {
    try {
      const res = await axios.get(`${API}/qr`);
      if (res.data.qr) {
        setQr(res.data.qr);
      }
    } catch (err) {
      console.error("QR fetch failed:", err);
    }
  }

  async function generateQr() {
    try {
      setLoading(true);
      setQr(null);
      setMessage("");
      await axios.post(`${API}/generate-qr`);
      // Wait a moment then start fetching QR
      setTimeout(async () => {
        await loadQr();
        await loadStatus();
        setLoading(false);
      }, 2000);
    } catch (err) {
      console.error(err);
      setMessage("Failed to generate QR. Try again.");
      setLoading(false);
    }
  }

  async function reconnect() {
    try {
      setLoading(true);
      setMessage("");
      await axios.post(`${API}/reconnect`);
      setTimeout(async () => {
        await loadStatus();
        setLoading(false);
      }, 3000);
    } catch (err) {
      console.error(err);
      setMessage("Reconnect failed. Try again.");
      setLoading(false);
    }
  }

  if (!status) {
    return (
      <div style={styles.center}>
        <p>Loading...</p>
      </div>
    );
  }

  // ── Derived flags ─────────────────────────────────────────────────────────
  const isConnected = status.connected;
  const needsReAuth = status.reAuthRequired;
  const isReconnecting = status.state === "RECONNECTING";
  const hasAuth = !needsReAuth; // If reauth not required, auth likely exists
  const showReconnect = !isConnected && !needsReAuth && hasAuth;
  const showGenerateQr = needsReAuth && !qr;
  const showQr = !!qr;

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>WhatsApp Dashboard</h1>

      {/* ── Connection Status ── */}
      <div style={{
        ...styles.statusBadge,
        background: isConnected ? "#d4edda" : needsReAuth ? "#f8d7da" : "#fff3cd",
        borderColor: isConnected ? "#28a745" : needsReAuth ? "#dc3545" : "#ffc107"
      }}>
        <span style={{ fontSize: "20px" }}>
          {isConnected ? "🟢" : needsReAuth ? "🔴" : "🟡"}
        </span>
        <strong style={{ marginLeft: "8px" }}>
          {isConnected
            ? "Connected"
            : needsReAuth
            ? "Re-authentication Required"
            : isReconnecting
            ? `Reconnecting... (attempt ${status.reconnectAttempts})`
            : "Disconnected"}
        </strong>
      </div>

      {/* ── Status Details ── */}
      <div style={styles.card}>
        <Row label="State" value={status.state} />
        <Row label="Reconnect Attempts" value={status.reconnectAttempts} />
        <Row label="ReAuth Required" value={status.reAuthRequired ? "Yes" : "No"} />
        <Row
          label="Last Connected"
          value={status.lastConnectedAt
            ? new Date(status.lastConnectedAt).toLocaleString()
            : "-"}
        />
        <Row
          label="Last Disconnect"
          value={status.lastDisconnectAt
            ? new Date(status.lastDisconnectAt).toLocaleString()
            : "-"}
        />
        <Row label="Disconnect Reason" value={status.lastDisconnectReason || "-"} />
        <Row label="Error" value={status.error || "-"} />
      </div>

      {/* ── Feedback Message ── */}
      {message && (
        <p style={styles.errorMsg}>{message}</p>
      )}

      {/* ── Reconnect Button (auth exists but disconnected) ── */}
      {showReconnect && (
        <button
          onClick={reconnect}
          disabled={loading}
          style={styles.btnPrimary}
        >
          {loading ? "Reconnecting..." : "🔄 Reconnect"}
        </button>
      )}

      {/* ── Generate QR Button (reauth required, no QR yet) ── */}
      {showGenerateQr && (
        <div style={styles.qrSection}>
          <p style={{ color: "#721c24", marginBottom: "12px" }}>
            WhatsApp session expired or no credentials found.
            Generate a QR code to log in again.
          </p>
          <button
            onClick={generateQr}
            disabled={loading}
            style={styles.btnDanger}
          >
            {loading ? "Generating QR..." : "📱 Generate QR Code"}
          </button>
        </div>
      )}

      {/* ── QR Code Display ── */}
      {showQr && (
        <div style={styles.qrSection}>
          <p style={{ marginBottom: "12px", fontWeight: "bold" }}>
            Scan this QR code with WhatsApp
          </p>
          <div style={styles.qrBox}>
            <QRCodeSVG value={qr} size={250} />
          </div>
          <p style={{ marginTop: "10px", color: "#888", fontSize: "13px" }}>
            QR auto-refreshes every 15 seconds if not scanned
          </p>
          <button
            onClick={generateQr}
            disabled={loading}
            style={{ ...styles.btnDanger, marginTop: "12px" }}
          >
            {loading ? "Refreshing..." : "🔄 Refresh QR"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Helper component ──────────────────────────────────────────────────────────

function Row({ label, value }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}:</span>
      <span>{value}</span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  container: {
    maxWidth: "700px",
    margin: "40px auto",
    padding: "24px",
    fontFamily: "Arial, sans-serif",
    border: "1px solid #ddd",
    borderRadius: "12px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)"
  },
  title: {
    marginTop: 0,
    marginBottom: "20px"
  },
  center: {
    textAlign: "center",
    marginTop: "50px"
  },
  statusBadge: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    borderRadius: "8px",
    border: "1px solid",
    marginBottom: "20px"
  },
  card: {
    background: "#f9f9f9",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "20px"
  },
  row: {
    display: "flex",
    gap: "8px",
    padding: "4px 0",
    borderBottom: "1px solid #eee"
  },
  rowLabel: {
    fontWeight: "bold",
    minWidth: "160px",
    color: "#555"
  },
  qrSection: {
    marginTop: "20px",
    padding: "20px",
    border: "1px solid #dc3545",
    borderRadius: "8px",
    textAlign: "center"
  },
  qrBox: {
    display: "inline-block",
    padding: "12px",
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: "8px"
  },
  btnPrimary: {
    padding: "10px 24px",
    fontSize: "15px",
    cursor: "pointer",
    background: "#007bff",
    color: "#fff",
    border: "none",
    borderRadius: "6px"
  },
  btnDanger: {
    padding: "10px 24px",
    fontSize: "15px",
    cursor: "pointer",
    background: "#dc3545",
    color: "#fff",
    border: "none",
    borderRadius: "6px"
  },
  errorMsg: {
    color: "#dc3545",
    marginBottom: "12px"
  }
};

export default App;
