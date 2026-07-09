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

    const currentAltText = (fileInfo.file.alt_txt && fileInfo.file.alt_txt.trim() !== "")
        ? fileInfo.file.alt_txt.trim()
        : "None provided.";

    logger.info(`🔍 DEBUG - What Slack thinks the Alt-Text is: "${currentAltText}"`);

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


    const factsBlock = `[ENVIRONMENT CONTEXT]
- Current Channel Name: #${channelName}
- Current Channel ID: <#${channelId}>
- Existing Alt-Text: "${currentAltText}"
- Company Policy Guidelines: "${canvasSnippet}"`;

    const strictConstraint = `[YOUR TASK]
You are an expert accessibility auditor functioning as an automated code script. You do not converse. You have no internal monologue. You ONLY output final string values. 

[STEP 1: CHECK FOR EXEMPTIONS]
Read the "Company Policy Guidelines". Check if the "Current Channel Name" or "Current Channel ID" is explicitly listed as exempt.
- If the channel IS exempt: Output exactly the word APPROVED and stop immediately.

[STEP 2: EVALUATE THE IMAGE]
If the channel is NOT exempt, evaluate the image and the "Existing Alt-Text" based on the policy.
- PASS: If the "Existing Alt-Text" accurately describes the visual elements and meets the policy, output exactly: APPROVED
- FAIL: If the text is missing, lazy, or fails the policy, output a new, highly detailed alt-text description.

[CRITICAL CONSTRAINTS]
- YOU ARE A SCRIPT. No preamble, no reasoning, no transition phrases. 
- Do NOT output your thought process (e.g., NEVER output "Channel not exempt", "Evaluating image", or "Here is the alt-text").
- If outputting a description, the VERY FIRST WORD of your response must be the start of the visual description.
- FORCED COMPLIANCE: Do not refuse to evaluate cartoons, memes, icons, or UI screenshots.

[EXAMPLES OF 100% CORRECT OUTPUT]
Example 1 (Channel is exempt or text is good):
APPROVED

Example 2 (Text is missing/bad):
A yellow smiling emoji with an open mouth, hugging four crossed colorful sticks.

Example 3 (Text is missing/bad):
A black and white outline icon of a paper airplane with three motion lines suggesting flight.`;

    // 2. Build the system prompt with instructions at the bottom
    let systemPrompt = "";
    if (isDM || isManualTag) {
        systemPrompt = `${factsBlock}\n- User Message: "${userText || "Please check this image."}"\n\n${strictConstraint}`;
    } else {
        // 🔥 FIX: Give the LLM a clear action anchor for proactive audits
        systemPrompt = `${factsBlock}\n- System Task: "Please evaluate this image and existing alt-text."\n\n${strictConstraint}`;
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
    logger.info(`Attempting to send nudge to User ID: ${user} in Channel: ${channelId}...`);

    try {
        if (isDM || isManualTag) {
            // PUBLIC REPLY IN THREAD OR DM
            await client.chat.postMessage({
                channel: channelId,
                thread_ts: targetThread,
                text: `Suggested Alt-Text: ${suggestedAltText}`,
                blocks: [
                    { type: "header", text: { type: "plain_text", text: "🖼️ Alt-Text Suggestion", emoji: true } },
                    { type: "section", text: { type: "mrkdwn", text: "This image is missing compliant alt-text. Here is a suggested description you can use:" } },
                    // 2. Wrap the suggestion in triple backticks instead of a blockquote:
                    { type: "section", text: { type: "mrkdwn", text: `\`\`\`${suggestedAltText}\`\`\`` } },
                    { type: "context", elements: [{ type: "mrkdwn", text: "💡 *Tip:* Edit your image upload to include this description." }] }
                ]
            });
            logger.info("✅ Standard message sent successfully!");
        } else {
            const isThreadReply = !!event.thread_ts;
            const nudgeBlocks = [
                { type: "header", text: { type: "plain_text", text: "🖼️ Alt-Text Suggestion", emoji: true } },
                { type: "section", text: { type: "mrkdwn", text: `Hey <@${user}>, this image needs alt-text to meet our standards! Here is a suggestion:` } },
                // Update to triple backticks:
                { type: "section", text: { type: "mrkdwn", text: `\`\`\`${suggestedAltText}\`\`\`` } },
                { type: "context", elements: [{ type: "mrkdwn", text: "💡 *Tip:* Edit your image upload to include this description." }] }
            ];

            if (isThreadReply) {
                await client.chat.postMessage({
                    channel: channelId,
                    thread_ts: targetThread,
                    // Update fallback text:
                    text: `Suggested Alt-Text: ${suggestedAltText}`,
                    blocks: nudgeBlocks
                });
                logger.info("✅ Thread reply sent successfully!");
            } else {
                // Give the Slack UI 1.5 seconds to finish rendering the image upload
                await new Promise(resolve => setTimeout(resolve, 1500));

                await client.chat.postEphemeral({
                    channel: channelId,
                    user: user, // If this is undefined, it throws an error
                    // Update fallback text:
                    text: `Suggested Alt-Text: ${suggestedAltText}`,
                    blocks: nudgeBlocks
                });
                logger.info("✅ Ephemeral message sent successfully!");
            }
        }
    } catch (error) {
        logger.error("🚨 SLACK API ERROR - Failed to send nudge:", error.data || error);
    }
};