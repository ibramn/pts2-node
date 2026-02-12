import crypto from "node:crypto";

export type DigestChallenge = {
  realm?: string;
  nonce?: string;
  qop?: string; // e.g. "auth" or "auth,auth-int"
  opaque?: string;
  algorithm?: string; // e.g. "MD5", "SHA-256", "MD5-sess"
  charset?: string;
};

function splitAuthParams(header: string): string[] {
  // Splits on commas not inside quotes.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseDigestChallenge(wwwAuthenticate: string): DigestChallenge {
  // Example: Digest realm="PTS", nonce="...", qop="auth", algorithm=MD5
  const prefixMatch = wwwAuthenticate.match(/^\s*Digest\s+(.*)$/i);
  if (!prefixMatch) throw new Error("Not a Digest challenge");
  const rest = prefixMatch[1] ?? "";

  const params: DigestChallenge = {};
  for (const part of splitAuthParams(rest)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    (params as any)[k] = v;
  }
  return params;
}

function pickQop(qop: string | undefined): string | undefined {
  if (!qop) return undefined;
  const parts = qop
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.includes("auth")) return "auth";
  return parts[0];
}

function hash(algorithm: string, data: string): string {
  const norm = algorithm.toUpperCase();
  const nodeAlg =
    norm === "MD5" || norm === "MD5-SESS"
      ? "md5"
      : norm === "SHA-256" || norm === "SHA-256-SESS"
        ? "sha256"
        : "md5"; // fallback
  return crypto.createHash(nodeAlg).update(data).digest("hex");
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function buildDigestAuthorization(params: {
  username: string;
  password: string;
  method: string;
  uri: string; // request-uri, e.g. "/jsonPTS"
  challenge: DigestChallenge;
  nc: number;
}): string {
  const realm = params.challenge.realm ?? "";
  const nonce = params.challenge.nonce ?? "";
  const algorithmRaw = params.challenge.algorithm ?? "MD5";
  const algorithm = algorithmRaw.toUpperCase();
  const qop = pickQop(params.challenge.qop);
  const opaque = params.challenge.opaque;

  const cnonce = randomHex(16);
  const ncStr = params.nc.toString(16).padStart(8, "0");

  const ha1Base = `${params.username}:${realm}:${params.password}`;
  let ha1 = hash(algorithm, ha1Base);
  if (algorithm.endsWith("-SESS")) {
    ha1 = hash(algorithm, `${ha1}:${nonce}:${cnonce}`);
  }

  // We only support qop=auth in practice for this device protocol.
  const ha2 = hash(algorithm, `${params.method}:${params.uri}`);

  const response = qop
    ? hash(algorithm, `${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${nonce}:${ha2}`);

  const parts: string[] = [];
  parts.push(`username="${params.username}"`);
  parts.push(`realm="${realm}"`);
  parts.push(`nonce="${nonce}"`);
  parts.push(`uri="${params.uri}"`);
  parts.push(`response="${response}"`);

  if (opaque) parts.push(`opaque="${opaque}"`);
  if (params.challenge.charset) parts.push(`charset="${params.challenge.charset}"`);

  // Per RFC, algorithm token is usually unquoted.
  if (params.challenge.algorithm) parts.push(`algorithm=${params.challenge.algorithm}`);

  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${ncStr}`);
    parts.push(`cnonce="${cnonce}"`);
  }

  return `Digest ${parts.join(", ")}`;
}

