import { startHostedServer } from "./Server.js";
import { z } from "zod";

const app = await startHostedServer({
  directory: process.env.REA_PUBLIC_DATA ?? "/data/rea-public",
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT ?? "8080"),
});
process.stdout.write("REA public static analysis service is listening.\n");
for (const event of ["SIGTERM", "SIGINT"] as const)
  process.once(event, () => {
    void app.close();
  });
