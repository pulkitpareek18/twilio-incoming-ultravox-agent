# Twilio Voice AI Assistant with Ultravox

> A powerful Voice AI implementation using Twilio and Ultravox for handling incoming and outgoing calls with AI-powered conversations.

## Watch Tutorial Video

Watch the Implementation Tutorial on YouTube:

<p align="center">
    <a href="https://youtu.be/AbJKBgN_pMU">
        <img src="https://img.youtube.com/vi/AbJKBgN_pMU/0.jpg" alt="Twilio Voice AI Implementation Tutorial" width="560" height="315">
    </a>
</p>

<p align="center">
    <a href="https://www.youtube.com/channel/UCxgkN3luQgLQOd_L7tbOdhQ?sub_confirmation=1">
        <img src="https://img.shields.io/badge/Subscribe-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Subscribe">
    </a>
</p>

## Introduction

This project demonstrates how to build an intelligent voice assistant using Twilio and Ultravox AI. It can handle both incoming and outgoing calls, perfect for customer service, lead qualification, or automated follow-ups.

## Key Features

- **Intelligent Voice Conversations**: Natural language interactions powered by Ultravox AI
- **Dual Mode Support**: Handles both incoming and outgoing calls
- **Contact Information Tracking**: Automatically captures and utilizes caller information
- **Dynamic Context Handling**: Adapts conversation based on call context
- **Professional Voice**: Uses high-quality voice synthesis for natural conversations
- **Customizable Scripts**: Easily modifiable system prompts for different use cases

## Technical Stack

- **Twilio**: Telephony infrastructure
- **Ultravox AI**: Conversational AI engine
- **Express.js**: Web server framework
- **dotenv**: Environment configuration
- **Node.js**: Runtime environment

## System Architecture

1. **Incoming Call Flow**
   - Webhook endpoint for incoming calls
   - Automatic caller information capture
   - Dynamic AI response generation

2. **Outgoing Call Flow**
   - Programmatic call initiation
   - Custom conversation context setting
   - Automated follow-up handling

3. **Environment Configuration**
   - Secure credentials management
   - Easy configuration setup
   - Development/Production environment support

## Setup Instructions

### Prerequisites
- Node.js installed
- Twilio account with:
  - Account SID
  - Auth Token
  - Twilio phone number
- Ultravox API key
 - MongoDB connection string
 - Google Gemini API key

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/twilio-voice-ai.git
   cd twilio-voice-ai
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with your configuration:
   ```env
   PORT=3000
   BASE_URL=https://your-public-url
   ULTRAVOX_API_KEY=your_ultravox_api_key
   ULTRAVOX_API_URL=https://api.ultravox.ai/api/calls
   ULTRAVOX_MODEL=fixie-ai/ultravox
   ULTRAVOX_VOICE_ID=9f6262e3-1b03-4a0b-9921-50b9cff66a43
   ULTRAVOX_TEMPERATURE=0.7
   FIRST_SPEAKER=FIRST_SPEAKER_AGENT
   # If Ultravox supports event callbacks, point this to your public webhook
   ULTRAVOX_EVENT_WEBHOOK=${BASE_URL}/ultravox/events

    # MongoDB
    MONGODB_URI=mongodb+srv://user:pass@cluster/dbname?retryWrites=true&w=majority
    MONGODB_DB=ultravox
    MONGODB_COLLECTION=conversations

    # Gemini (Google Generative AI)
    GEMINI_API_KEY=your_gemini_api_key
    GEMINI_MODEL=gemini-1.5-flash
   ```

### Running the Application

For incoming calls:
```bash
node index.js
```

Make sure to configure your Twilio webhook URL to point to your server's `/incoming` endpoint.

### Webhooks and Transcripts

- Ultravox events can POST to `/ultravox/events`. The handler is schema-agnostic and will try to persist `callId`, `from`, `transcript`, and `summary` if present.
- You can also POST transcripts manually to `/conversations` with body:
  ```json
  { "callId": "abc123", "from": "+12345550123", "transcript": "...", "summary": "..." }
  ```

### Dashboard

- Visit `/dashboard` to see all conversations, risk classification, and counselling recommendation.
- Click into a row to view full transcript and AI-style review.

Data is stored locally at `data/conversations.json`.
If `MONGODB_URI` is set, data is stored in MongoDB (`${MONGODB_DB}.${MONGODB_COLLECTION}`) and the JSON file is ignored.

### Notes on AI Classification

- If `GEMINI_API_KEY` is provided, Gemini generates the dashboard review and labels.
- If Gemini is unavailable or returns invalid JSON, a rule-based fallback is used.

## Known Limitations

- Requires stable internet connection
- Webhook endpoint needs to be publicly accessible
- Call quality depends on network conditions
- Limited to one conversation flow at a time

## Extending the System

The system can be extended by:
- Adding database integration for call logging
- Implementing custom conversation flows
- Adding analytics and reporting
- Integrating with CRM systems

## Need Professional Implementation?

Looking to implement a custom Voice AI solution for your business? Our team at KnoLabs specializes in building AI-powered communication systems.

 [Contact Us for Professional Implementation](https://knolabs.biz/collect-requirement-page)

## Hosting Partners
- [Kamatera - Get $100 Free VPS Credit](https://knolabs.biz/100-dollar-free-credit)
- [Hostinger - Additional 20% Discount](https://knolabs.biz/20-Percent-Off-VPS)

## Documentation
For more information about Ultravox and its capabilities, visit: [Ultravox Documentation](https://docs.ultravox.ai)

## License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.