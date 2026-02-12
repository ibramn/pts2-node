import { z } from "zod";

const Pts2ConfigSchema = z.object({
  host: z.string().min(1),
  security: z.enum(["http", "https"]),
  httpPort: z.number().int().positive(),
  httpsPort: z.number().int().positive(),
  auth: z.enum(["basic", "digest"]),
  login: z.string(),
  password: z.string(),
  timeoutMs: z.number().int().positive(),
  tlsInsecure: z.boolean()
});

export type Pts2Config = z.infer<typeof Pts2ConfigSchema>;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const norm = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(norm)) return true;
  if (["0", "false", "no", "n", "off"].includes(norm)) return false;
  return fallback;
}

function parseIntOr(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadPts2ConfigFromEnv(env: NodeJS.ProcessEnv): Pts2Config {
  const cfg = {
    host: env.PTS2_HOST ?? "",
    security: (env.PTS2_SECURITY ?? "https").toLowerCase(),
    httpPort: parseIntOr(env.PTS2_HTTP_PORT, 80),
    httpsPort: parseIntOr(env.PTS2_HTTPS_PORT, 443),
    auth: (env.PTS2_AUTH ?? "digest").toLowerCase(),
    login: env.PTS2_LOGIN ?? "",
    password: env.PTS2_PASSWORD ?? "",
    timeoutMs: parseIntOr(env.PTS2_TIMEOUT_MS, 15000),
    tlsInsecure: parseBool(env.PTS2_TLS_INSECURE, true)
  };

  return Pts2ConfigSchema.parse(cfg);
}

