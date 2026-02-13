import { Agent, fetch } from "undici";
import { buildDigestAuthorization, parseDigestChallenge } from "./digest.js";
import {
  buildEnvelope,
  JsonPtsPacketError,
  JsonPtsPacketRequest,
  JsonPtsPacketResponse,
  parseEnvelope
} from "./jsonpts.js";
import type { Pts2Config } from "./config.js";

export type Pts2TransportErrorKind = "network" | "timeout";

export class Pts2TransportError extends Error {
  public readonly kind: Pts2TransportErrorKind;
  public readonly url: string;
  public readonly code?: string;

  constructor(params: { kind: Pts2TransportErrorKind; url: string; message: string; code?: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.name = "Pts2TransportError";
    this.kind = params.kind;
    this.url = params.url;
    if (params.code !== undefined) {
      this.code = params.code;
    }
  }
}

export class Pts2Client {
  private readonly cfg: Pts2Config;
  private readonly dispatcher?: Agent;
  private digestNc = 0;

  constructor(cfg: Pts2Config) {
    this.cfg = cfg;
    if (cfg.security === "https" && cfg.tlsInsecure) {
      this.dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false
        }
      });
    }
  }

  private baseUrl(): string {
    const port = this.cfg.security === "https" ? this.cfg.httpsPort : this.cfg.httpPort;
    return `${this.cfg.security}://${this.cfg.host}:${port}/jsonPTS`;
  }

  private requestPathname(): string {
    return "/jsonPTS";
  }

  private basicAuthHeader(): string {
    const token = Buffer.from(`${this.cfg.login}:${this.cfg.password}`, "utf8").toString("base64");
    return `Basic ${token}`;
  }

  private async postJson(body: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    const url = this.baseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const init: Parameters<typeof fetch>[1] = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(extraHeaders ?? {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      };
      if (this.dispatcher) {
        init.dispatcher = this.dispatcher;
      }

      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, init);
      } catch (err: any) {
        // Node/undici typically throws TypeError("fetch failed") with a `cause` containing details.
        const cause: any = err?.cause;
        const code = String(cause?.code ?? err?.code ?? "");
        const isTimeout =
          err?.name === "AbortError" ||
          code === "UND_ERR_ABORTED" ||
          code === "ETIMEDOUT" ||
          code === "ESOCKETTIMEDOUT";
        const kind: Pts2TransportErrorKind = isTimeout ? "timeout" : "network";
        const causeMsg = String(cause?.message ?? err?.message ?? "fetch failed");
        const codeVal = code || undefined;
        throw new Pts2TransportError({
          kind,
          url,
          ...(codeVal ? { code: codeVal } : {}),
          message: `PTS2 ${kind} error calling ${url}: ${causeMsg}`,
          cause: err
        });
      }

      if (res.status === 401) {
        // Handle auth at a higher level
        return { __unauthorized: true, headers: res.headers };
      }

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
      }

      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postWithAuth(body: unknown): Promise<unknown> {
    if (this.cfg.auth === "basic") {
      return this.postJson(body, { Authorization: this.basicAuthHeader() });
    }

    // Digest: try without auth first to get the challenge, then retry.
    const first = await this.postJson(body);
    if ((first as any)?.__unauthorized) {
      const hdrs = (first as any).headers as Headers;
      const www = hdrs.get("www-authenticate");
      if (!www) throw new Error("401 without WWW-Authenticate header");

      const challenge = parseDigestChallenge(www);
      this.digestNc += 1;
      const authz = buildDigestAuthorization({
        username: this.cfg.login,
        password: this.cfg.password,
        method: "POST",
        uri: this.requestPathname(),
        challenge,
        nc: this.digestNc
      });
      return this.postJson(body, { Authorization: authz });
    }

    return first;
  }

  /**
   * Low-level helper: forward a raw jsonPTS envelope to the controller.
   * Useful for proxying browser requests without re-shaping packets.
   */
  async sendJsonPtsEnvelope(envelope: unknown): Promise<unknown> {
    return this.postWithAuth(envelope);
  }

  async execute(packets: JsonPtsPacketRequest[]): Promise<JsonPtsPacketResponse[]> {
    const envelope = buildEnvelope(packets);
    const raw = await this.postWithAuth(envelope);
    const parsed = parseEnvelope(raw);

    // Correlate IDs to request count
    if (parsed.length !== packets.length) {
      throw new Error(`Packet count mismatch: sent ${packets.length}, got ${parsed.length}`);
    }
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i]!.id !== i) {
        throw new Error(`Packet id mismatch at index ${i}: got ${parsed[i]!.id}`);
      }
    }

    const firstError = parsed.find((p) => p.error);
    if (firstError) throw new JsonPtsPacketError(firstError);

    return parsed;
  }

  // High-level helpers (subset used by CLI/server)

  async loadConfiguration(): Promise<JsonPtsPacketResponse[]> {
    return this.execute([
      { type: "GetSystemDecimalDigits" },
      { type: "GetMeasurementUnits" },
      { type: "GetPumpsConfiguration" },
      { type: "GetFuelGradesConfiguration" },
      { type: "GetPumpNozzlesConfiguration" },
      { type: "GetProbesConfiguration" },
      { type: "GetUsersConfiguration" },
      { type: "GetConfigurationIdentifier" }
    ]);
  }

  async getDateTime(): Promise<{ dateTime: Date; autoSynchronize: boolean; utcOffset: number }> {
    const [pkt] = await this.execute([{ type: "GetDateTime" }]);
    const data = (pkt?.data ?? {}) as any;
    if (!data.DateTime) throw new Error("Missing DateTime in response");
    return {
      dateTime: new Date(String(data.DateTime)),
      autoSynchronize: Boolean(data.AutoSynchronize),
      utcOffset: Number.parseInt(String(data.UTCOffset ?? "0"), 10)
    };
  }

  async setDateTime(params: { dateTime: string; utcOffset?: number; autoSynchronize?: boolean }): Promise<boolean> {
    const data = {
      DateTime: params.dateTime,
      UTCOffset: params.utcOffset ?? 0,
      AutoSynchronize: params.autoSynchronize ?? false
    };
    const [pkt] = await this.execute([{ type: "SetDateTime", data }]);
    // Confirmation-style responses are device-dependent; treat non-error as success.
    return !pkt!.error;
  }

  async reportGetPumpTransactions(params: {
    pump: number;
    from: string;
    to: string;
  }): Promise<unknown[]> {
    const data = {
      Pump: params.pump,
      DateTimeStart: params.from,
      DateTimeEnd: params.to
    };
    const [pkt] = await this.execute([{ type: "ReportGetPumpTransactions", data }]);
    if (!Array.isArray(pkt!.data)) return [];
    return pkt!.data as unknown[];
  }
}

