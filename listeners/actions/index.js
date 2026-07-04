import { handleFeedbackButton } from './feedback-buttons.js';
import { approveAltTextCallback } from './approveAltText.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('approve_alt_text', approveAltTextCallback);
  app.action('feedback', handleFeedbackButton);
}
