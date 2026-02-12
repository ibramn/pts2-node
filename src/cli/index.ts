import "dotenv/config";
import { Command } from "commander";
import { z } from "zod";
import { formatPtsDateTime, JsonPtsPacketError, loadPts2ConfigFromEnv, Pts2Client } from "../core/index.js";

const program = new Command();

program
  .name("pts2")
  .description("PTS2 jsonPTS CLI")
  .version("0.1.0");

program
  .command("test")
  .description("Run a safe test flow (load config, get datetime, sample report).")
  .option("--pump <number>", "Pump number for report (default 0)", "0")
  .option("--report", "Run ReportGetPumpTransactions for today", true)
  .option("--set-datetime", "Set device datetime to local now (disabled by default)", false)
  .action(async (opts) => {
    try {
      const cfg = loadPts2ConfigFromEnv(process.env);
      const client = new Pts2Client(cfg);

      console.log("Loading configuration...");
      await client.loadConfiguration();
      console.log("OK");

      console.log("GetDateTime...");
      const dt = await client.getDateTime();
      console.log(`Device DateTime: ${dt.dateTime.toISOString()}`);

      if (opts.setDatetime) {
        const now = new Date();
        const formatted = formatPtsDateTime(now);
        console.log(`SetDateTime -> ${formatted}`);
        await client.setDateTime({ dateTime: formatted, utcOffset: 0, autoSynchronize: false });
        console.log("OK");
      }

      if (opts.report) {
        const pump = Number.parseInt(String(opts.pump), 10);
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 0);
        const from = formatPtsDateTime(start);
        const to = formatPtsDateTime(end);

        console.log(`ReportGetPumpTransactions pump=${pump} from=${from} to=${to}`);
        const rows = await client.reportGetPumpTransactions({ pump, from, to });
        console.log(`Rows: ${rows.length}`);
        if (rows.length > 0) {
          console.log(JSON.stringify(rows.slice(0, 5), null, 2));
          if (rows.length > 5) console.log("... (truncated)");
        }
      }
    } catch (err) {
      if (err instanceof JsonPtsPacketError) {
        console.error(err.message);
        console.error(JSON.stringify(err.packet, null, 2));
      } else if (err instanceof z.ZodError) {
        console.error("PTS2 config is missing/invalid. Create `.env` from `.env.example` and set at least PTS2_HOST.");
        console.error(JSON.stringify(err.issues, null, 2));
      } else if (err instanceof Error) {
        console.error(err.message);
      } else {
        console.error(err);
      }
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

