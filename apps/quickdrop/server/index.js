import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
const address = await app.listen();
const shown = address.address === '0.0.0.0' || address.address === '::' ? 'localhost' : address.address;
console.log(`[quickdrop] ${config.appName} is running at http://${shown}:${address.port}`);
console.log(`[quickdrop] data directory: ${config.dataDir}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[quickdrop] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
