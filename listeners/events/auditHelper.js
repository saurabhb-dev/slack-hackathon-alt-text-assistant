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
        
        CRITICAL INSTRUCTION: Be extremely concise. In 1-2 short sentences, ask them to upload an image for auditing. Then, add a quick final sentence letting them know they can set custom organizational rules (like exempting #memes) by pinning a policy in a public "#accessibility-standards" channel. Do not use filler greetings or long explanations.
        
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
    // const currentAltText = fileInfo.file.alt_txt ? `"${fileInfo.file.alt_txt}"` : "MISSING (Requires new description)";
    // const currentAltText = fileInfo.file.alt_txt || "NONE";
    const currentAltText = (fileInfo.file.alt_txt && fileInfo.file.alt_txt.trim() !== "")
        ? fileInfo.file.alt_txt.trim()
        : "NO_ALT_TEXT_PROVIDED";

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


    // We add an explicit instruction to NEVER consider an image "APPROVED" 
    // unless the provided alt-text is already high-quality and present.


    // 2. Branch Prompt Logic based on interaction mode (Conversational vs Passive Monitoring)
    // 1. Declare all factual data clearly at the very top
    // 1. Declare all factual data clearly at the very top (NOW INCLUDES ID)
    const factsBlock = `[ENVIRONMENT CONTEXT]
- Current Channel Name: #${channelName}
- Current Channel ID: ${channelId}
- Existing Alt-Text: "${currentAltText}"
- Company Policy Guidelines: "${canvasSnippet}"`;

    const strictConstraint = `[INSTRUCTIONS - FOLLOW EXACTLY IN THIS ORDER]

1. STEP 1 (CHECK EXEMPTIONS): Look at the "Current Channel Name" and "Current Channel ID" in the context above. Check if EITHER of those exact values are explicitly listed in the "Company Policy Guidelines" as exempt or excluded. If there is an EXACT match, you MUST stop immediately and output ONLY the word "APPROVED". Do not evaluate the image.
2. STEP 2 (EVALUATE EXISTING TEXT): If the channel is NOT explicitly exempt, check the "Existing Alt-Text". If it is "NO_ALT_TEXT_PROVIDED", skip this step and proceed to Step 3. If it contains actual text, evaluate it. If it is a reasonably accurate description, output EXACTLY and ONLY the word "APPROVED". Do not over-correct.
3. STEP 3 (GENERATE NEW TEXT): If the "Existing Alt-Text" is "NO_ALT_TEXT_PROVIDED", OR if it is inaccurate/lazy (e.g., "bad alt text", "image", "test"), you MUST analyze the image and write a new, highly descriptive alt-text.
4. STRICT FORMATTING: If generating new text, output ONLY the raw description text. No intros, no quotes. NEVER output "APPROVED" in this step, and NEVER output "NO_ALT_TEXT_PROVIDED".`;

    // 2. Build the system prompt with instructions at the bottom
    let systemPrompt = "";
    if (isDM || isManualTag) {
        systemPrompt = `${factsBlock}
- User Message: "${userText || "Please check this image."}"

${strictConstraint}`;
    } else {
        systemPrompt = `${factsBlock}

${strictConstraint}`;
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
    const isApproved = output.replace(/[^a-zA-Z]/g, '').toUpperCase() === "APPROVED";
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