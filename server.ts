import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import twilio from "twilio";
import Database from "better-sqlite3";
import path from "path";
import { WaveFile } from "wavefile";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const db = new Database("calls.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    phone_number TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    summary TEXT,
    transcript TEXT,
    status TEXT DEFAULT 'ongoing'
  )
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio Webhook for incoming calls
app.post("/api/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  
  // Stream audio to our WebSocket
  const stream = connect.stream({
    url: `wss://${req.headers.host}/api/stream`,
  });
  
  // Store call info
  const callSid = req.body.CallSid;
  const from = req.body.From;
  db.prepare("INSERT INTO calls (id, phone_number) VALUES (?, ?)").run(callSid, from);

  res.type("text/xml");
  res.send(twiml.toString());
});

// API for summaries
app.get("/api/calls", (req, res) => {
  const calls = db.prepare("SELECT * FROM calls ORDER BY start_time DESC").all();
  res.json(calls);
});

app.post("/api/calls/make", async (req, res) => {
  const { phoneNumber } = req.body;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/api/voice`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER!,
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/calls/:id/summary", (req, res) => {
  const { summary, transcript } = req.body;
  db.prepare("UPDATE calls SET summary = ?, transcript = ?, status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?")
    .run(summary, transcript, req.params.id);
  res.json({ success: true });
});

// WebSocket for Twilio Media Stream
// We will relay this to the frontend
let frontendSocket: WebSocket | null = null;
let twilioSocket: WebSocket | null = null;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  
  if (url.pathname === "/api/frontend") {
    console.log("Frontend connected to WebSocket");
    frontendSocket = ws;
    
    ws.on("message", (message) => {
      const data = JSON.parse(message.toString());
      if (data.event === "audio_out" && twilioSocket && twilioSocket.readyState === WebSocket.OPEN) {
        // Relay audio from frontend to Twilio
        // We need the streamSid which is stored in the twilioSocket context or passed in the message
        // For now, we'll assume the twilioSocket has the streamSid if we store it.
      }
    });

    ws.on("close", () => {
      frontendSocket = null;
    });
  } else if (url.pathname === "/api/stream") {
    console.log("Twilio connected to WebSocket");
    twilioSocket = ws;
    let streamSid: string | null = null;
    let callSid: string | null = null;

    ws.on("message", (message) => {
      const data = JSON.parse(message.toString());
      
      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          console.log(`Stream started: ${streamSid} for call ${callSid}`);
          if (frontendSocket) {
            frontendSocket.send(JSON.stringify({ event: "call_started", callSid }));
          }
          break;
        case "media":
          if (frontendSocket) {
            const mulawBuffer = Buffer.from(data.media.payload, "base64");
            const wav = new WaveFile();
            wav.fromScratch(1, 8000, "8m", mulawBuffer);
            wav.toSampleRate(16000);
            const pcmBuffer = Buffer.from(wav.getSamples(false, Int16Array).buffer);
            
            frontendSocket.send(JSON.stringify({ 
              event: "audio_in", 
              payload: pcmBuffer.toString("base64") 
            }));
          }
          break;
        case "stop":
          console.log("Stream stopped");
          if (frontendSocket) {
            frontendSocket.send(JSON.stringify({ event: "call_ended", callSid }));
          }
          break;
      }
    });

    // Listen for audio from frontend to send to Twilio
    // We need to handle this in the frontendSocket listener, but we need the streamSid.
    // Let's update the frontendSocket listener to use the current twilioSocket and its streamSid.
    if (frontendSocket) {
      frontendSocket.on("message", (message) => {
        const data = JSON.parse(message.toString());
        if (data.event === "audio_out" && streamSid && ws.readyState === WebSocket.OPEN) {
          const pcmBuffer = Buffer.from(data.payload, "base64");
          const wav = new WaveFile();
          wav.fromScratch(1, 16000, "16", new Int16Array(pcmBuffer.buffer));
          wav.toSampleRate(8000);
          wav.toMuLaw();
          const mulawBuffer = Buffer.from(wav.getSamples(false, Uint8Array).buffer);

          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: mulawBuffer.toString("base64")
            }
          }));
        }
      });
    }

    ws.on("close", () => {
      twilioSocket = null;
    });
  }
});

// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
  }

  const PORT = 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
