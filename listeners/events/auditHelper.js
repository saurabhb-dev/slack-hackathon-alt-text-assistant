import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// NEW: Agentic fallback for text-only DMs and Mentions
export const runConversationalAgent = async ({ event, client, logger, targetThread }) => {
    const channelId = event.channel || event.channel_id;
    // Strip out the bot's @mention tag so the LLM just reads the user's words
    const userText = (event.text || "").replace(/<@[A-Z0-9]+>/g, '').trim() || "Hello!";

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a Slack Assistant dedicated to Image Accessibility. 
        The user just said "${userText}". 
        Politely greet them and ask them to upload an image so you can audit its alt-text. 
        
        CRITICAL INSTRUCTION: As part of your greeting, you MUST briefly inform the user that they can create their own organization policy for accessibility standards (including excluding channels like #memes or #random). Tell them to do this by creating a public channel named "#accessibility-standards", writing their custom policy in a message, and pinning it.
        
        Do not answer other questions.
    STRICT GUARDRAIL: Under NO circumstances should you answer general knowledge questions, perform mathematical computations, write code, or act as a general AI assistant. If the user asks you to do anything other than audit an image, you must politely refuse and remind them of your sole purpose.`
                },
                { role: "user", content: userText }
            ]
        });

        await client.chat.postMessage({
            channel: channelId,
            thread_ts: targetThread,
            text: "Accessibility Assistant", // Fallback for notifications
            blocks: [
                { type: "header", text: { type: "plain_text", text: "👋 Accessibility Assistant", emoji: true } },
                { type: "section", text: { type: "mrkdwn", text: response.choices[0].message.content.trim() } }
            ]
        });
    } catch (error) {
        logger.error("Error in conversational agent:", error);
    }
};


export const runAuditLogic = async ({ file, event, client, logger, canvasSnippet, targetThread, isManualTag }) => {
    const channelId = event.channel || event.channel_id;
    const user = event.user_id || event.user;
    const isDM = channelId && channelId.startsWith('D');
    const userText = (event.text || "").replace(/<@[A-Z0-9]+>/g, '').trim();

    // 1. Prepare Image
    const imageResponse = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const arrayBuffer = await imageResponse.arrayBuffer();
    const dataUrl = `data:${file.mimetype};base64,${Buffer.from(arrayBuffer).toString('base64')}`;

    const fileInfo = await client.files.info({ file: file.id });
    const currentAltText = fileInfo.file.alt_txt || "None provided";

    // NEW: Fetch the human-readable channel name so the LLM knows where it is
    let channelName = "unknown";
    if (!isDM) {
        try {
            const channelInfo = await client.conversations.info({ channel: channelId });
            channelName = channelInfo.channel.name;
        } catch (e) {
            logger.error("Could not fetch channel info:", e);
        }
    }

    logger.info(`🧠 Agent Context: Image was posted in #${channelName}. Evaluating against policy...`);

    // 2. Branch Prompt Logic based on interaction mode (Conversational vs Passive Monitoring)
    let systemPrompt = "";
    // We add an explicit instruction to NEVER consider an image "APPROVED" 
    // unless the provided alt-text is already high-quality and present.
    const strictConstraint = `CRITICAL: You are an auditor, NOT a describer. 
1. Compare the provided "Existing alt-text" and the channel context against the Company guidelines.
2. If the guidelines state the image is EXEMPT based on the channel it was posted in (e.g., a social channel), you MUST output ONLY the word "APPROVED".
3. If the "Existing alt-text" is already accurate, descriptive, and meets guidelines, you MUST output ONLY the word "APPROVED".
4. ONLY if the image requires alt-text AND the existing text is missing or poor, should you provide a new description.
5. STRICT FORMATTING: When providing a new description, output ONLY the raw description text. Do NOT include introductory phrases like "Existing alt-text:" or "Suggested description:".`;

    if (isDM || isManualTag) {
        systemPrompt = `You are a strict accessibility auditor. ${strictConstraint} 
        Context: The user posted this in "#${channelName}".
        Company guidelines: ${canvasSnippet}. Existing alt-text: "${currentAltText}". 
        The user said: "${userText || "Please check this image."}"`;
    } else {
        systemPrompt = `You are an expert accessibility auditor. ${strictConstraint}
        Context: The user posted this in "#${channelName}".
        Company guidelines: ${canvasSnippet}. Existing alt-text: "${currentAltText}".`;
    }

    // 2. Call OpenAI
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: [{ type: "text", text: "Evaluate." }, { type: "image_url", image_url: { url: dataUrl } }] }
        ]
    });

    const output = response.choices[0].message.content.trim();

    // 🔥 DEBUG: See exactly what the AI is returning
    logger.info(`LLM Raw Output: "${output}"`);

    // STRICT CHECK: Only mark as approved if the output is exactly "APPROVED" (case-insensitive)
    const isApproved = output.toUpperCase() === "APPROVED";
    const suggestedAltText = isApproved ? "" : output;


    // 3. CLEANUP: Forcibly remove BOTH the reaction and the Assistant status
    try { await client.reactions.remove({ channel: channelId, name: 'robot_face', timestamp: targetThread }); } catch (e) { /* ignore */ }
    try { await client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: targetThread, status: "" }); } catch (e) { /* ignore */ }

    // 4. Routing: DM vs Channel
    if (isApproved) {
        logger.info("Audit approved, exiting.");
        if (isDM || isManualTag) {
            await client.chat.postMessage({
                channel: channelId,
                thread_ts: targetThread,
                text: "Approved",
                blocks: [{ type: "header", text: { type: "plain_text", text: "✅ Alt-Text Approved", emoji: true } },
                { type: "section", text: { type: "mrkdwn", text: "Great job! The alt-text for this image is compliant with our standards." } }]
            });
        }
        return;
    }

    // NUDGE LOGIC
    // 5. Handle Non-Approved (Nudge or DM Draft)
    logger.info("Sending nudge...");
    if (isDM || isManualTag) {
        // PUBLIC REPLY IN THREAD
        await client.chat.postMessage({
            channel: channelId,
            thread_ts: targetThread,
            text: "Accessibility Nudge",
            blocks: [
                { type: "header", text: { type: "plain_text", text: "🖼️ Alt-Text Suggestion", emoji: true } },
                { type: "section", text: { type: "mrkdwn", text: "This image is missing compliant alt-text. Here is a suggested description you can use:" } },
                { type: "section", text: { type: "mrkdwn", text: `> ${suggestedAltText}` } },
                { type: "context", elements: [{ type: "mrkdwn", text: "💡 *Tip:* Edit your image upload to include this description." }] }
            ]
        });
    } else {
        const isThreadReply = !!event.thread_ts;
        const nudgeBlocks = [
            { type: "header", text: { type: "plain_text", text: "🖼️ Alt-Text Suggestion", emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: `Hey <@${user}>, this image needs alt-text to meet our standards! Here is a suggestion:` } },
            { type: "section", text: { type: "mrkdwn", text: `> ${suggestedAltText}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: "💡 *Tip:* Edit your image upload to include this description." }] }
        ];
        if (isThreadReply) {
            await client.chat.postMessage({
                channel: channelId,
                thread_ts: targetThread,
                text: "Accessibility Nudge",
                blocks: nudgeBlocks
            });
        } else {
            await client.chat.postEphemeral({
                channel: channelId,
                user: user,
                text: "Accessibility Nudge",
                blocks: nudgeBlocks
            });
        }
    }
};