import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const app = createApp(prisma);
const port = Number(process.env.PORT || 5000);
const server = app.listen(port, () => console.log(`NIPOPETO API listening on http://localhost:${port}`));

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
