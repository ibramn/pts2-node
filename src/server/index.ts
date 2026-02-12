import "dotenv/config";
import express from "express";
import { z } from "zod";
import { formatPtsDateTime, JsonPtsPacketError, loadPts2ConfigFromEnv, Pts2Client, Pts2TransportError } from "../core/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirCandidates = [
  // When running via tsx (source)
  path.resolve(__dirname, "public"),
  // When running compiled JS from dist/ (public assets stay in src/)
  path.resolve(__dirname, "../../src/server/public")
];
const publicDir = publicDirCandidates.find((p) => fs.existsSync(path.join(p, "index.html")));
if (publicDir) {
  app.use(express.static(publicDir));
}

let cachedClient: Pts2Client | undefined;
function getClient(): Pts2Client {
  if (cachedClient) return cachedClient;
  const cfg = loadPts2ConfigFromEnv(process.env);
  cachedClient = new Pts2Client(cfg);
  return cachedClient;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/datetime", async (_req, res) => {
  try {
    const client = getClient();
    const dt = await client.getDateTime();
    res.json({
      dateTime: formatPtsDateTime(dt.dateTime),
      iso: dt.dateTime.toISOString(),
      autoSynchronize: dt.autoSynchronize,
      utcOffset: dt.utcOffset
    });
  } catch (err) {
    handleError(res, err);
  }
});

const SetDateTimeSchema = z.object({
  dateTime: z.string().min(1),
  utcOffset: z.number().int().optional(),
  autoSynchronize: z.boolean().optional()
});

app.post("/datetime/set", async (req, res) => {
  try {
    const client = getClient();
    const body = SetDateTimeSchema.parse(req.body);
    const ok = await client.setDateTime({
      dateTime: body.dateTime,
      utcOffset: body.utcOffset ?? 0,
      autoSynchronize: body.autoSynchronize ?? false
    });
    res.json({ ok });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/config/load", async (_req, res) => {
  try {
    const client = getClient();
    const packets = await client.loadConfiguration();
    res.json({ packets });
  } catch (err) {
    handleError(res, err);
  }
});

const PumpTxSchema = z.object({
  pump: z.number().int().nonnegative(),
  from: z.string().min(1),
  to: z.string().min(1)
});

app.post("/report/pump-transactions", async (req, res) => {
  try {
    const client = getClient();
    const body = PumpTxSchema.parse(req.body);
    const rows = await client.reportGetPumpTransactions({
      pump: body.pump,
      from: body.from,
      to: body.to
    });
    res.json({ rows });
  } catch (err) {
    handleError(res, err);
  }
});

function handleError(res: express.Response, err: unknown) {
  if (err instanceof JsonPtsPacketError) {
    res.status(502).json({
      error: "PTS_PACKET_ERROR",
      message: err.message,
      packet: err.packet
    });
    return;
  }
  if (err instanceof Pts2TransportError) {
    res.status(err.kind === "timeout" ? 504 : 502).json({
      error: "PTS_TRANSPORT_ERROR",
      kind: err.kind,
      url: err.url,
      code: err.code,
      message: err.message
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "BAD_REQUEST", issues: err.issues });
    return;
  }
  if (err instanceof Error) {
    res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR", message: String(err) });
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`PTS2 REST listening on http://localhost:${port}`);
});

