import { fileSharedCallback } from './fileShared.js';

export function register(app) {
  // 1. Catch ALL messages (DMs, Channel texts, and Tags)
  app.message(/.*/, async (args) => {
    await fileSharedCallback(args);
  });

  // 2. Catch explicit mentions (Just in case you add it to your manifest later)
  app.event('app_mention', async (args) => {
    await fileSharedCallback(args);
  });

  // 3. Catch legacy file_shared events
  app.event('file_shared', async (args) => {
    await fileSharedCallback(args);
  });

  // NEW: Proactive Onboarding
  // NEW: Proactive Onboarding
  app.event('app_home_opened', async ({ event, client, logger }) => {
    try {
      logger.info(`app_home_opened triggered! Tab: ${event.tab || 'unknown'}`);

      // Open (or fetch) the DM channel between the bot and the user
      const dm = await client.conversations.open({ users: event.user });

      // Fetch the most recent message in this DM
      const history = await client.conversations.history({
        channel: dm.channel.id,
        limit: 1 // We only need one to prove history exists
      });

      // If the history is totally empty, it's their first time! Send the onboarding.
      if (history.messages.length === 0) {
        logger.info(`Sending onboarding message to new user: ${event.user}`);

        await client.chat.postMessage({
          channel: dm.channel.id,
          text: "Welcome to the Alt-Text Assistant!",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "🖼️ Welcome to the Alt-Text Assistant!", emoji: true }
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "I am here to help make our workspace inclusive and screen-reader friendly.\n\n💡 *What I do:*\n• Automatically audit image uploads in public and private channels for compliant alt-text.\n• Provide optimized description suggestions when guidelines aren't met.\n\n🤖 *How to use me here:*\nSimply drop an image directly into this DM, and I will instantly audit it and help you write the perfect description before you post it publicly!\n\n⚙️ *Customize for your Workspace:*\nYou can define your own organization's accessibility policy and exempt specific channels (like `#random` or `#memes`).\n\n*To set this up:*\n1️⃣ Create a public channel named `#accessibility-standards`\n2️⃣ Write your custom policy in a message\n3️⃣ Pin that message to the channel\n\nI will automatically read the pinned message and apply your unique rules to all future audits!"
              }
            }
          ]
        });
      }
    } catch (error) {
      logger.error("Error in app_home_opened:", error);
    }
  });
}