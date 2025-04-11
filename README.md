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

3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```

4. Add your credentials to `.env`:
   ```
   ULTRAVOX_API_KEY=your_ultravox_api_key
   ```

### Running the Application

For incoming calls:
```bash
node index.js
```

Make sure to configure your Twilio webhook URL to point to your server's `/incoming` endpoint.

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