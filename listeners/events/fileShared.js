// IMPORT THE NEW CONVERSATIONAL AGENT
import { runAuditLogic, runConversationalAgent } from './auditHelper.js';

export const fileSharedCallback = async ({ event, client, logger, body, ack, context }) => {
    if (ack) { try { await ack(); } catch (e) { } }
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== 'file_share') return;

    const channelId = event.channel || event.channel_id;
    const isDM = event.channel_type === "im" || (channelId && channelId.startsWith("D"));
    const botUserId = context?.botUserId || process.env.SLACK_BOT_USER_ID;
    const isMention = event.type === 'app_mention' || (event.text && botUserId && event.text.includes(`<@${botUserId}>`));

    let targetFile = event.file || (event.files && event.files[0]);
    let targetThread = event.thread_ts || event.ts;
    const isManualTag = isDM || isMention;
    const isExplicitTrigger = isMention;

    // SCENARIO 1: Thread Tagging (Find the most recent image)
    if (!targetFile && event.thread_ts && isManualTag && !isDM) {
        try {
            const result = await client.conversations.replies({ channel: channelId, ts: event.thread_ts });

            // Slack returns thread messages in chronological order (oldest to newest).
            // We loop backward to find the image closest to the user's tag.
            const messages = result.messages || [];
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                const foundFile = msg.files?.find(f => f.mimetype && f.mimetype.startsWith('image/'));

                if (foundFile) {
                    targetFile = foundFile;
                    logger.info("Found the most recent image in the thread replies.");
                    break; // Stop looking once we find the newest image
                }
            }
        } catch (e) {
            logger.error("Failed to fetch thread:", e);
        }
    }

    // SCENARIO 2: Text-only message (Conversational Fallback)
    // If there is no image to audit, hand the user's text over to the conversational agent
    if (!targetFile) {
        if (isManualTag) {
            logger.info("No image found, routing to conversational agent.");
            try { await client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: targetThread, status: "is typing..." }); } catch (e) { }

            await runConversationalAgent({ event, client, logger, targetThread });

            try { await client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: targetThread, status: "" }); } catch (e) { }
        }
        return;
    }

    // SCENARIO 3: Process the Image
    if (!targetFile.mimetype || !targetFile.mimetype.startsWith("image/")) return;

    try { await client.reactions.add({ channel: channelId, name: 'robot_face', timestamp: targetThread }); } catch (e) { }
    try { await client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: targetThread, status: "is analyzing..." }); } catch (e) { }

    let canvasSnippet = "Ensure images have descriptive alt-text summarizing the data.";
    const actionToken = event.assistant_thread?.action_token || body?.event?.assistant_thread?.action_token;

    // Fetch context (RTS for active sessions, standard search for background)
    if (actionToken) {
        try {
            const searchResponse = await client.apiCall('assistant.search.context', {
                query: 'Image Accessibility Policy has:pin in:#accessibility-standards',
                action_token: actionToken
            });
            if (searchResponse.results?.messages?.[0]?.text) {
                canvasSnippet = searchResponse.results.messages[0].text;
            }
        } catch (e) { logger.error("RTS Failed:", e); }
    } else {
        try {
            const searchResponse = await client.search.messages({
                token: process.env.SLACK_USER_TOKEN,
                query: 'Image Accessibility Policy has:pin in:#accessibility-standards',
                count: 1
            });
            if (searchResponse.messages?.matches?.length > 0) {
                canvasSnippet = searchResponse.messages.matches[0].text;
            }
        } catch (error) { logger.error("Legacy Search Failed:", error); }
    }

    logger.info(`🔍 Canvas Snippet being sent to LLM: ${canvasSnippet}`);
    await runAuditLogic({ file: targetFile, event, client, logger, canvasSnippet, targetThread, isManualTag });
};