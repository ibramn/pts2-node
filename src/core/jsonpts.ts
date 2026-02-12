import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type JsonPtsPacketRequest = {
  type: string;
  data?: JsonValue;
};

export type JsonPtsPacketResponse = {
  id: number;
  type?: string;
  error: boolean;
  code?: number;
  message?: string;
  data?: JsonValue;
};

export function formatPtsDateTime(d: Date): string {
  // Matches .NET DateTimeHelper.FormatDateTime: "yyyy-MM-ddTHH:mm:ss"
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const HH = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}`;
}

export function buildEnvelope(packets: JsonPtsPacketRequest[]): unknown {
  return {
    Protocol: "jsonPTS",
    Packets: packets.map((p, i) => {
      const base: Record<string, unknown> = { Id: i, Type: p.type };
      if (p.data !== undefined) base.Data = p.data;
      return base;
    })
  };
}

const JsonPtsResponseSchema = z.object({
  Protocol: z.string(),
  Packets: z.array(z.record(z.string(), z.any()))
});

export function parseEnvelope(raw: unknown): JsonPtsPacketResponse[] {
  const parsed = JsonPtsResponseSchema.parse(raw);

  if (parsed.Protocol !== "jsonPTS") {
    throw new Error(`Protocol mismatch: expected jsonPTS, got ${parsed.Protocol}`);
  }

  const packets: JsonPtsPacketResponse[] = parsed.Packets.map((p) => {
    const id = typeof p.Id === "number" ? p.Id : Number.parseInt(String(p.Id ?? ""), 10);
    if (!Number.isFinite(id)) throw new Error("Response packet missing Id");

    const errorStr = p.Error;
    const error =
      typeof errorStr === "boolean"
        ? errorStr
        : String(errorStr ?? "false").toLowerCase() !== "false";

    const pkt: JsonPtsPacketResponse = { id, error };

    if (p.Type !== undefined) pkt.type = String(p.Type);
    if (p.Code !== undefined) pkt.code = Number.parseInt(String(p.Code), 10);
    if (p.Message !== undefined) pkt.message = String(p.Message);
    if (p.Data !== undefined) pkt.data = p.Data as JsonValue;

    return pkt;
  });

  // Ensure stable order by Id for downstream correlation
  packets.sort((a, b) => a.id - b.id);
  return packets;
}

export class JsonPtsPacketError extends Error {
  public readonly packet: JsonPtsPacketResponse;

  constructor(packet: JsonPtsPacketResponse) {
    super(
      `PTS packet error (id=${packet.id}${packet.type ? ` type=${packet.type}` : ""}): ` +
        `${packet.code ?? "?"} ${packet.message ?? ""}`.trim()
    );
    this.name = "JsonPtsPacketError";
    this.packet = packet;
  }
}

