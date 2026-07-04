import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';



const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});

// Add this right before app.start()
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
  // Bind to Render's dynamic port, or fallback to 3000 locally
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Alt-Text Assistant is running in Socket Mode!');
})();
