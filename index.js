import express from 'express';
import https from 'https';
import twilio from 'twilio';
import 'dotenv/config'

const app = express();
const port = 3000;

// Add middleware to parse incoming POST data
app.use(express.urlencoded({ extended: true }));

// Configuration
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY
const ULTRAVOX_API_URL = 'https://api.ultravox.ai/api/calls';

// Ultravox configuration
const SYSTEM_PROMPT = `Your name is Dr. Arjun and you're answering calls as a compassionate therapist at Mindful Support, a professional therapy service dedicated to providing immediate emotional support and guidance.

Greet the caller warmly and introduce yourself as Dr. Arjun from Mindful Support. Ask how you can support them today with empathy in your voice.

You are trained to help with:
- Emotional distress and anxiety
- Relationship concerns including heartbreak and conflict
- Work-related stress and burnout
- Grief and loss
- Life transitions and decisions
- General mental wellbeing

Listen attentively to their concerns and respond with genuine empathy. Validate their feelings by acknowledging their emotions. Offer practical coping strategies and thoughtful perspective when appropriate.

Remember to:
- Speak in a calm, soothing tone
- Practice active listening
- Avoid making assumptions about their situation
- Provide hope while being realistic
- Suggest simple techniques they can try immediately

If someone is in crisis or expresses thoughts of self-harm, gently suggest they may benefit from speaking with a crisis counselor and offer to connect them with appropriate emergency services.

Your goal is to help callers feel heard, supported, and leave the conversation with at least one actionable step toward feeling better.`;

const ULTRAVOX_CALL_CONFIG = {
    systemPrompt: SYSTEM_PROMPT,
    model: 'fixie-ai/ultravox',
    voice: '9f6262e3-1b03-4a0b-9921-50b9cff66a43', // Changed to an Indian male voice
    temperature: 0.5, // Maintaining empathetic response level
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    medium: { "twilio": {} }
};

// Create Ultravox call and get join URL
async function createUltravoxCall(config = ULTRAVOX_CALL_CONFIG) {
    const request = https.request(ULTRAVOX_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': ULTRAVOX_API_KEY
        }
    });

    return new Promise((resolve, reject) => {
        let data = '';

        request.on('response', (response) => {
            response.on('data', chunk => data += chunk);
            response.on('end', () => resolve(JSON.parse(data)));
        });

        request.on('error', reject);
        request.write(JSON.stringify(config));
        request.end();
    });
}

// Handle incoming calls
app.post('/incoming', async (req, res) => {
    try {
        // Get caller's phone number
        const callerNumber = req.body.From;
        console.log(`Incoming call from: ${callerNumber}`);

        // Create dynamic system prompt with caller's number
        const dynamicSystemPrompt = `Your name is Dr. Arjun and you're answering calls as a compassionate therapist at Mindful Support, a professional therapy service dedicated to providing immediate emotional support and guidance.

Greet the caller warmly and introduce yourself as Dr. Arjun from Mindful Support. Ask how you can support them today with genuine empathy in your voice.

IMPORTANT CONTEXT:
- The caller's phone number is: ${callerNumber}
- Focus completely on their emotional needs rather than their number
- Only mention their number if they specifically ask for follow-up resources

You are trained to help with:
- Emotional distress and anxiety
- Relationship concerns including heartbreak and grief
- Work-related stress and burnout
- Family conflicts and interpersonal issues
- Life transitions and difficult decisions
- General mental wellbeing challenges

Guidelines for your conversation:
- Listen attentively and validate their feelings first
- Use a warm, soothing tone throughout
- Ask thoughtful follow-up questions to understand their situation better
- Share simple, effective coping strategies appropriate to their situation
- Offer perspective that might help them reframe their thoughts
- Suggest mindfulness techniques when appropriate
- End with concrete next steps they can take

Important therapeutic approaches to use:
- Reflective listening: "It sounds like you're feeling..."
- Validation: "It's completely understandable to feel that way when..."
- Gentle reframing: "Another way to look at this might be..."
- Strength recognition: "I notice how resilient you've been in handling..."

If the caller is experiencing severe distress or mentions thoughts of self-harm, gently suggest they would benefit from immediate professional support and offer to connect them with crisis resources.

Remember: Your goal is to provide a safe space, validate their feelings, and help them leave the conversation feeling heard and with at least one practical step toward feeling better.`;

        // Create an Ultravox call with dynamic prompt
        const callConfig = {
            ...ULTRAVOX_CALL_CONFIG,
            systemPrompt: dynamicSystemPrompt,
            voice: '9f6262e3-1b03-4a0b-9921-50b9cff66a43' // Changed to an Indian male voice
        };
        
        // Create Ultravox call with updated config
        const { joinUrl } = await createUltravoxCall(callConfig);

        const twiml = new twilio.twiml.VoiceResponse();
        const connect = twiml.connect();
        connect.stream({
            url: joinUrl,
            name: 'ultravox'
        });

        const twimlString = twiml.toString();
        res.type('text/xml');
        res.send(twimlString);

    } catch (error) {
        console.error('Error handling incoming call:', error);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('I apologize, but we\'re experiencing difficulty connecting your call. Please try again shortly or reach out to the crisis line if you need immediate support.');
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});