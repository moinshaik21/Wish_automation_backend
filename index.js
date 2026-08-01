/**
 * Always-on WhatsApp sender for the Wish Ledger.
 *
 * Uses whatsapp-web.js, which drives a real WhatsApp Web session logged in
 * with YOUR OWN phone number (via QR-code scan, same as opening
 * web.whatsapp.com). It's free and unofficial — WhatsApp does not sanction
 * this, so keep the message volume sane (a handful of wishes a day is fine).
 *
 * This has to run on a host that stays running 24/7 (Railway, Render, a
 * small VPS, even a spare machine at home) because the login session lives
 * in memory + a local folder. It CANNOT run on Netlify Functions or GitHub
 * Actions, since those spin up fresh and disappear after each run.
 *
 * What it does:
 *  - On first boot, prints/serves a QR code. Scan it once from
 *    WhatsApp on your phone: Settings -> Linked Devices -> Link a Device.
 *  - Saves the session to ./session (LocalAuth) so you only scan once,
 *    as long as that folder persists between restarts/deploys.
 *  - Runs a check every CHECK_INTERVAL_MINUTES (default: hourly), and once
 *    more at CRON_TIME as a final catch-all. Each check scans the Google
 *    Sheet for anyone whose Date matches today (DD-MM).
 *  - Exposes POST /send-today so the web dashboard's
 *    "Send today's wishes now" button can trigger the same logic on demand.
 *  - "Sent" state lives IN THE SHEET (a `Delivered` column, written back as
 *    YYYY-MM-DD after a successful send) instead of a local file — this
 *    means it survives redeploys, restarts, and VM reboots, and manual +
 *    automatic sends can never double-send each other. A row is only sent
 *    again once its Delivered year differs from the current year (i.e. once
 *    per birthday/anniversary per year). Pass ?force=true to /send-today to
 *    bypass this and force a resend (handy for testing).
 *
 * @format
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const cron = require("node-cron");
const qrcode = require("qrcode");
const { google } = require("googleapis");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = process.env.PORT || 3000;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET || "";
const CRON_TIME = process.env.CRON_TIME || "30 8 * * *"; // final catch-all send, default 8:30 AM
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 60); // safety-net frequency
const TIMEZONE = process.env.TZ || "Asia/Kolkata";
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 4000); // pause between messages, avoids spam-flagging

let latestQr = null; // data URL, shown at /qr until the client is ready
let clientReady = false;
let sendInProgress = false; // simple lock so overlapping triggers can't double-send

// ---------- Google Sheet helpers ----------
// Needs EDIT access (not just read) because we write the Delivered column back.
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function columnLetter(index) {
  // 0 -> A, 1 -> B, ... good enough for a sheet with < 26 columns
  return String.fromCharCode(65 + index);
}

async function getSheetsClient() {
  const credsJson = JSON.parse(process.env.GOOGLE_CREDS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credsJson,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}

async function getSheetRows(sheets) {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1",
  });
  const rows = res.data.values || [];
  const headers = rows[0] || [];
  const col = (n) => headers.indexOf(n);

  const nameIdx = col("Name");
  const phoneIdx = col("Phone");
  const occasionIdx = col("Occasion");
  const dateIdx = col("Date");
  const messageIdx = col("Message");
  const DeliveredIdx = col("Delivered");

  if (DeliveredIdx === -1) {
    throw new Error(
      "Sheet is missing a 'Delivered' column header. Add one more column header called exactly `Delivered` (e.g. in F1) and leave the column empty for existing rows.",
    );
  }

  return rows.slice(1).map((row, i) => ({
    rowNumber: i + 2, // 1-indexed sheet row, +1 to skip the header row
    name: (row[nameIdx] || "").trim(),
    phone: (row[phoneIdx] || "").trim(),
    occasion: (row[occasionIdx] || "").trim(),
    date: (row[dateIdx] || "").trim(),
    message: (row[messageIdx] || "").trim(),
    Delivered: (row[DeliveredIdx] || "").trim(),
    DeliveredCol: columnLetter(DeliveredIdx),
  }));
}

async function markRowSent(sheets, row) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const todayFull = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!${row.DeliveredCol}${row.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[todayFull]] },
  });
}

function alreadySentThisYear(Delivered) {
  if (!Delivered) return false;
  const year = Delivered.slice(0, 4);
  return year === String(new Date().getFullYear());
}

function buildDefaultMessage(name, occasion) {
  const o = occasion.trim().toLowerCase();
  if (o === "birthday")
    return `🎉 Happy Birthday, ${name}! Wishing you a wonderful year ahead filled with joy and success!`;
  if (o === "anniversary")
    return `💐 Happy Anniversary, ${name}! Wishing you both continued love and happiness!`;
  return `🎊 Happy ${occasion}, ${name}!`;
}

function todayStr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

// ---------- WhatsApp client ----------

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, "session") }),
  puppeteer: {
    headless: true,
    // Use the system Chromium installed via `apt install chromium-browser`
    // instead of Puppeteer's own bundled download — smaller and lets us
    // control it directly. Leave unset (undefined) to fall back to the
    // bundled one if PUPPETEER_EXECUTABLE_PATH isn't set.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // avoids /dev/shm OOM on small VMs
      "--disable-gpu",
      "--disable-extensions",
      "--single-process", // saves RAM at the cost of a little stability
    ],
  },
});

client.on("qr", async (qr) => {
  latestQr = await qrcode.toDataURL(qr);
  console.log("Scan the QR code at GET /qr (or check the terminal below).");
});

client.on("ready", () => {
  clientReady = true;
  latestQr = null;
  console.log("WhatsApp client is ready.");
});

client.on("disconnected", (reason) => {
  clientReady = false;
  console.log("WhatsApp client disconnected:", reason);
});

client.initialize();

async function sendWhatsAppMessage(phone, body) {
  // whatsapp-web.js wants "<countrycode><number>@c.us", no leading +
  const chatId = `${phone.replace(/[^\d]/g, "")}@c.us`;
  await client.sendMessage(chatId, body);
}

async function runDailySend({ force = false } = {}) {
  if (!clientReady) {
    throw new Error(
      "WhatsApp client is not ready yet — scan the QR code at /qr first.",
    );
  }
  if (sendInProgress) {
    return {
      skipped: true,
      reason: "a send was already running, skipped this trigger",
      sent: 0,
      failed: 0,
    };
  }
  sendInProgress = true;

  try {
    const sheets = await getSheetsClient();
    const rows = await getSheetRows(sheets);
    const key = todayStr(); // DD-MM

    const todays = rows.filter(
      (r) => r.name && r.phone && r.occasion && r.date === key,
    );
    const toSend = force
      ? todays
      : todays.filter((r) => !alreadySentThisYear(r.Delivered));
    const alreadyDone = todays.length - toSend.length;

    let sent = 0;
    let failed = 0;
    const details = [];

    for (const row of toSend) {
      const body = row.message
        ? row.message
        : buildDefaultMessage(row.name, row.occasion);
      try {
        await sendWhatsAppMessage(row.phone, body);
        await markRowSent(sheets, row); // write the sent date back to the sheet immediately
        sent += 1;
        details.push({ name: row.name, phone: row.phone, ok: true });
      } catch (err) {
        failed += 1;
        details.push({
          name: row.name,
          phone: row.phone,
          ok: false,
          error: err.message,
        });
      }
      if (toSend.indexOf(row) < toSend.length - 1) {
        await sleep(SEND_DELAY_MS); // small pause between messages
      }
    }

    return {
      skipped: false,
      sent,
      failed,
      alreadyDone,
      total: todays.length,
      details,
    };
  } finally {
    sendInProgress = false;
  }
}

// ---------- HTTP server ----------

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, whatsappReady: clientReady });
});

app.get("/qr", (req, res) => {
  if (clientReady) {
    return res.send(
      "<h2>Already linked ✅</h2><p>The WhatsApp session is active — no QR needed.</p>",
    );
  }
  if (!latestQr) {
    return res.send(
      "<h2>Starting up…</h2><p>Refresh in a few seconds — the QR code is being generated.</p>",
    );
  }
  res.send(`
    <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
    <img src="${latestQr}" alt="WhatsApp QR code" />
  `);
});

app.post("/send-today", async (req, res) => {
  if (TRIGGER_SECRET && req.headers["x-trigger-secret"] !== TRIGGER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const force = req.query.force === "true";
    const result = await runDailySend({ force });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// ---------- Scheduler ----------
// Two triggers, both calling the SAME idempotent function — safe to overlap:
//  1. A frequent safety-net check (every CHECK_INTERVAL_MINUTES) that catches
//     today's birthdays automatically if nobody used the manual button yet.
//  2. CRON_TIME as a final guaranteed catch-all late in the day.
// Because "already sent" is tracked per-row in the sheet (Delivered column),
// none of these can double-send, and a manual click earlier in the day makes
// the later automatic runs into no-ops for that row.

cron.schedule(
  `*/${CHECK_INTERVAL_MINUTES} * * * *`,
  () => {
    runDailySend()
      .then((r) => {
        if (r.sent || r.failed) console.log("Auto-check send result:", r);
      })
      .catch((err) => console.error("Auto-check send failed:", err.message));
  },
  { timezone: TIMEZONE },
);

cron.schedule(
  CRON_TIME,
  () => {
    console.log("Running final catch-all send…");
    runDailySend()
      .then((r) => console.log("Catch-all send result:", r))
      .catch((err) => console.error("Catch-all send failed:", err.message));
  },
  { timezone: TIMEZONE },
);
