export const approveAltTextCallback = async ({ action, ack, respond, logger }) => {
  // 1. Acknowledge the button click immediately
  await ack(); 
  
  try {
    const payload = JSON.parse(action.value);
    
    // 2. Use 'respond' to safely overwrite the exact message the button was attached to.
    // This perfectly handles threads, DMs, and main channels automatically.
    await respond({
      replace_original: true,
      text: `🖼️ *Visual Description (Alt-Text):*\n_${payload.text}_`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🖼️ *Visual Description (Alt-Text):*\n> _${payload.text}_`
          }
        }
      ]
    });
    
    logger.info("Interactive prompt successfully replaced with alt-text caption.");
  } catch (error) {
    logger.error("Action failed:", error);
  }
};