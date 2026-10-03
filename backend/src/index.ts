import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { drainServer } from "./lib/shutdown.js";

const app = createApp(prisma);
const port = Number(process.env.PORT || 5000);
const server = app.listen(port, () => console.log(`NIPOPETO API listening on http://localhost:${port}`));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await drainServer(server);
    await prisma.$disconnect();
  } catch (error) {
    console.error("Shutdown failed", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
