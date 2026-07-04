import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerListeners } from './listeners/index.js';
import http from 'http'; // 1. ADD THIS IMPORT

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});

// Global catcher
app.use(async ({ event, logger, next }) => {
  if (event) {
    logger.info(`🚨 GLOBAL CATCHER: Slack sent an event of type: ${event.type}`);
    if (event.subtype) {
      logger.info(`👉 Subtype: ${event.subtype}`);
    }
  }
  await next();
});

registerListeners(app);

(async () => {
  await app.start();
  console.log('⚡️ Alt-Text Assistant is running in Socket Mode!');

  // 2. ADD THIS DUMMY SERVER FOR RENDER
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Health check: OK');
  }).listen(port, () => {
    console.log(`Dummy HTTP server listening on port ${port} for Render.`);
  });
})();