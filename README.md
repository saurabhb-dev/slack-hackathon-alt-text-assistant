# Alt-Text Assistant 🚀

Alt-Text Assistant is an intelligent, context-aware Slack agent designed to ensure your workspace remains inclusive and accessible for blind and low-vision colleagues. Instead of relying on passive reminders or checkboxes, this agent automatically evaluates images shared across your workspace to ensure they include meaningful, compliant alternative text.

---

## 📺 Demo Video
See the Alt-Text Assistant in action: **[Watch the Demo on YouTube](https://www.youtube.com/watch?v=LX5VN2jDPJo)**

---

## 💡 Inspiration
Digital accessibility is a fundamental human right, but in fast-paced corporate communication, it is often treated as an afterthought. While Slack provides a native setting to remind or force users to add alt-text to their image uploads, it suffers from a massive compliance gap: **it cannot evaluate the semantic quality of the text.** 

Users frequently bypass native platform warnings by typing lazy placeholders like `"a graph"`, `"image"`, or `"test"`. While this technically fulfills the platform's requirement, it fails the core mission of inclusion, leaving team members who rely on screen readers completely in the dark. We built **Alt-Text Assistant** to bridge this exact platform gap—moving from surface-level compliance to genuine accessibility.

---

## 🛠️ What It Does
Alt-Text Assistant operates as a stateless compliance co-pilot across your workspace, adapting seamlessly to public channels, private channels, and direct messages (DMs).

* **Proactive Monitoring:** When a user drops an image into a channel without high-quality alt-text, the agent instantly analyzes it. Instead of a generic warning, it delivers a helpful nudge containing a fully drafted, context-rich alternative text description that the user can copy-paste to edit their post.
* **Interactive Workspace Drafting:** Users can direct message (DM) the assistant to utilize Slack’s native Assistant UI. This allows teams to safely draft and optimize complex image descriptions in a private sandbox before sharing them publicly.
* **On-Demand Thread Audits:** Tag the bot (`@Alt-Text Assistant`) in any existing thread containing an older image, and it will intelligently traverse the thread history to audit the specific image you need help with.

---

## ⚡ Setup & Environment Variables

To run Alt-Text Assistant locally or deploy it to a server, you must configure the following environment variables. Create a `.env` file in the root directory of your project:

```env
# Slack App Credentials
SLACK_SIGNING_SECRET=your_slack_signing_secret_here
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
SLACK_USER_TOKEN=xoxp-your-user-token-here

# OpenAI Credentials
OPENAI_API_KEY=sk-proj-your-openai-api-key-here
```

---

## 🧩 System Architecture

```text
+----------------+          (1) Drops Image          +--------------------+
|                | -------------------------------> |                    |
|   Slack User   |                                  |   Slack Platform   |
|                | <------------------------------- |                    |
+----------------+  (7) Delivers Ephemeral Nudge or +--------------------+
                        Threaded Alt-Text Draft              |   ^
                                                             |   |
                                       (2) Event: file_share |   | (6) Post Message API
                                                             v   |
                                                    +--------------------+
       +-----------------------+                    |                    |
       | Workspace Context     | <----------------- |    Node.js Agent   |
       |                       |  (3) Fetch Policy  |    (Slack Bolt)    |
       | (Real-Time Search API)|                    |                    |
       +-----------------------+                    +--------------------+
                                                             |   ^
                                       (4) Send Image Data + |   | (5) Returns "APPROVED" or
                                           Policy Context    |   |     Suggested Description
                                                             v   |
                                                    +--------------------+
                                                    |                    |
                                                    | OpenAI GPT-4o API  |
                                                    |  (Vision Model)    |
                                                    |                    |
                                                    +--------------------+