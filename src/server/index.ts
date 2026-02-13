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
let cachedClientKey: string | undefined;

const HostOverrideSchema = z.object({
  host: z.string().min(1)
});

function overridePath(): string {
  // Keep overrides in the project root so both tsx (src/) and dist/ can share it.
  return path.resolve(process.cwd(), "pts2-config.override.json");
}

function readHostOverride(): { host?: string } {
  try {
    const raw = fs.readFileSync(overridePath(), "utf8");
    const parsed = HostOverrideSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return { host: parsed.data.host };
  } catch {
    return {};
  }
}

function writeHostOverride(host: string): void {
  fs.writeFileSync(overridePath(), JSON.stringify({ host }, null, 2) + "\n", "utf8");
}

function deleteHostOverride(): void {
  try {
    fs.unlinkSync(overridePath());
  } catch {
    // ignore
  }
}

function effectiveEnvWithOverrides(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ovr = readHostOverride();
  if (ovr.host) {
    env.PTS2_HOST = ovr.host;
  }
  return env;
}

function getClient(): Pts2Client {
  const cfg = loadPts2ConfigFromEnv(effectiveEnvWithOverrides());
  const key = JSON.stringify(cfg);
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClientKey = key;
  cachedClient = new Pts2Client(cfg);
  return cachedClient;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Controller host (IP) override API
const HostSchema = z.object({
  host: z
    .string()
    .min(1)
    .refine((v) => /^[a-z0-9.-]+$/i.test(v), { message: "host must be an IP/hostname (letters, digits, dots, hyphen)" })
});

app.get("/api/pts2/host", (_req, res) => {
  const ovr = readHostOverride();
  res.json({
    host: ovr.host ?? (process.env.PTS2_HOST ?? ""),
    source: ovr.host ? "override" : "env"
  });
});

app.put("/api/pts2/host", (req, res) => {
  try {
    const body = HostSchema.parse(req.body);
    writeHostOverride(body.host);
    // Reset cached client so next call uses the new host.
    cachedClient = undefined;
    cachedClientKey = undefined;
    res.json({ ok: true, host: body.host });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/pts2/host", (_req, res) => {
  deleteHostOverride();
  cachedClient = undefined;
  cachedClientKey = undefined;
  res.json({ ok: true });
});

// Generic jsonPTS proxy (for browser UIs)
const JsonPtsEnvelopeSchema = z.object({
  Protocol: z.string().optional(),
  Packets: z.array(z.record(z.string(), z.any()))
});

app.post("/jsonPTS", async (req, res) => {
  try {
    const envelope = JsonPtsEnvelopeSchema.parse(req.body);
    if (envelope.Protocol && envelope.Protocol !== "jsonPTS") {
      res.status(400).json({ Error: true, Message: "PROTOCOL_MISMATCH", Data: { Protocol: String(envelope.Protocol) } });
      return;
    }
    const client = getClient();
    const raw = await client.sendJsonPtsEnvelope({ Protocol: "jsonPTS", Packets: envelope.Packets });
    res.json(raw);
  } catch (err) {
    // Return errors in a shape the legacy JS UI understands.
    if (err instanceof z.ZodError) {
      res.status(400).json({ Error: true, Message: "BAD_REQUEST", Data: { Issues: err.issues } });
      return;
    }
    if (err instanceof JsonPtsPacketError) {
      res.status(502).json({ Error: true, Message: err.message, Data: err.packet });
      return;
    }
    if (err instanceof Pts2TransportError) {
      res.status(err.kind === "timeout" ? 504 : 502).json({
        Error: true,
        Message: "PTS_TRANSPORT_ERROR",
        Data: { kind: err.kind, url: err.url, code: err.code, message: err.message }
      });
      return;
    }
    if (err instanceof Error) {
      res.status(500).json({ Error: true, Message: err.message });
      return;
    }
    res.status(500).json({ Error: true, Message: String(err) });
  }
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

