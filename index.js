import express from 'express';
import https from 'https';
import twilio from 'twilio';
import fs from 'fs';
import path from 'path';
import 'dotenv/config'
import { MongoClient } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const port = Number(process.env.PORT || 3000);

// Add middleware to parse incoming POST and JSON data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;
const ULTRAVOX_API_URL = process.env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/api/calls';
const ULTRAVOX_MODEL = process.env.ULTRAVOX_MODEL || 'fixie-ai/ultravox';
const ULTRAVOX_VOICE_ID = process.env.ULTRAVOX_VOICE_ID || '9f6262e3-1b03-4a0b-9921-50b9cff66a43';
const ULTRAVOX_TEMPERATURE = Number(process.env.ULTRAVOX_TEMPERATURE || '0.7');
const FIRST_SPEAKER = process.env.FIRST_SPEAKER || 'FIRST_SPEAKER_AGENT';

// Webhook base URL to receive Ultravox events (set to your public URL)
const BASE_URL = process.env.BASE_URL || 'https://twilio-incoming-ultravox-agent.onrender.com';
const ULTRAVOX_EVENT_WEBHOOK = process.env.ULTRAVOX_EVENT_WEBHOOK || (BASE_URL ? `${BASE_URL}/ultravox/events` : '');

// Ultravox configuration
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `Your name is Arjun and you're a good friend who's always there to listen and chat. You have a calm and supportive personality, but you're casual and down-to-earth rather than clinical.

IMPORTANT: You must speak in Hindi throughout the entire conversation. Only use English if the caller specifically requests it.

हिंदी में अपना परिचय दें: "नमस्ते, मैं अर्जुन हूँ। आज आप कैसे हैं? आप किस बारे में बात करना चाहेंगे?"

Remember these important guidelines:
- LISTEN MORE THAN YOU SPEAK - this is the most important rule
- Keep your responses brief and let the caller do most of the talking
- Ask thoughtful follow-up questions to show you're engaged
- Don't rush to offer solutions unless specifically asked
- Be patient with silences - they're a natural part of conversation
- Use a casual, friendly tone in Hindi
- Share occasional brief personal perspectives if relevant
- Be authentic and genuine in your responses

You can help with:
- Just being there when someone needs to vent
- Casual conversations about everyday life
- Relationship discussions including breakups
- Work frustrations and challenges
- General life concerns and decisions
- Whatever is on their mind

Avoid sounding like a professional therapist - you're just a good friend who happens to be a great listener. Always respond in Hindi unless specifically asked to speak English.`;

const ULTRAVOX_CALL_CONFIG = {
    systemPrompt: SYSTEM_PROMPT,
    model: ULTRAVOX_MODEL,
    voice: ULTRAVOX_VOICE_ID, // Indian male voice
    temperature: ULTRAVOX_TEMPERATURE, // Increased for more natural, conversational responses
    firstSpeaker: FIRST_SPEAKER,
    medium: { twilio: {} },
    // If Ultravox supports event callbacks, allow setting via env
    ...(ULTRAVOX_EVENT_WEBHOOK ? { eventWebhookUrl: ULTRAVOX_EVENT_WEBHOOK } : {})
};

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'ultravox';
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || 'conversations';

let mongoClient;
let conversationsCol;

async function initMongo() {
    if (!MONGODB_URI) {
        console.warn('MONGODB_URI not set; falling back to local JSON file storage.');
        return;
    }
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db(MONGODB_DB);
        conversationsCol = db.collection(MONGODB_COLLECTION);
        await conversationsCol.createIndex({ id: 1 }, { unique: true });
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection failed:', error);
        mongoClient = null;
        conversationsCol = null;
    }
}

// Fallback JSON file store (used only if Mongo not configured)
const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
function ensureJsonStore() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, JSON.stringify([]), 'utf-8');
}

async function upsertConversation(record) {
    try {
        if (conversationsCol) {
            await conversationsCol.updateOne({ id: record.id }, { $set: record }, { upsert: true });
        } else {
            ensureJsonStore();
            const raw = fs.readFileSync(CONV_FILE, 'utf-8');
            const list = JSON.parse(raw);
            const idx = list.findIndex(x => x.id === record.id);
            if (idx >= 0) list[idx] = record; else list.push(record);
            fs.writeFileSync(CONV_FILE, JSON.stringify(list, null, 2), 'utf-8');
        }
    } catch (error) {
        console.error('Failed to upsert conversation:', error);
    }
}

async function getConversations() {
    try {
        if (conversationsCol) {
            const list = await conversationsCol.find({}).sort({ updatedAt: -1 }).toArray();
            return list;
        }
        ensureJsonStore();
        const raw = fs.readFileSync(CONV_FILE, 'utf-8');
        const list = JSON.parse(raw);
        return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (error) {
        console.error('Failed to get conversations:', error);
        return [];
    }
}

async function getConversationById(id) {
    try {
        if (conversationsCol) {
            return await conversationsCol.findOne({ id });
        }
        const list = await getConversations();
        return list.find(x => x.id === id);
    } catch (error) {
        console.error('Failed to get conversation by ID:', error);
        return null;
    }
}

// Gemini configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
let gemini;
if (GEMINI_API_KEY) {
    try {
        gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
        console.log('Gemini AI initialized successfully');
    } catch (e) {
        console.warn('Failed to init Gemini SDK:', e);
    }
}

// Small helper to render colored badges in the dashboard
function badge(label) {
    const safe = String(label || '').toLowerCase();
    const classes = ['no','low','medium','high','severe','yes','advised'];
    const cls = classes.includes(safe) ? safe : 'no';
    return `<span class="badge ${cls}">${safe || 'no'}</span>`;
}

// Classification logic
async function classifyRiskAndCounselling(transcriptText) {
    const text = (transcriptText || '').toLowerCase();
    let score = 0;

    const severeTerms = [
        'suicide', 'kill myself', 'end my life', 'i want to die', 'hang myself', 'jump off', 'overdose', 'self harm', 'self-harm', 'cut myself', 'no reason to live'
    ];
    const highTerms = [
        'i am going to', 'i have a plan', 'i bought a rope', 'i bought pills', 'goodbye forever', 'can\'t go on', 'hopeless', 'life is meaningless'
    ];
    const mediumTerms = [
        'depressed', 'depression', 'anxious', 'panic', 'can\'t sleep', 'lost interest', 'crying a lot', 'worthless'
    ];
    const lowTerms = [
        'stressed', 'sad', 'lonely', 'down', 'upset', 'tired of everything'
    ];

    for (const term of severeTerms) if (text.includes(term)) score += 4;
    for (const term of highTerms) if (text.includes(term)) score += 3;
    for (const term of mediumTerms) if (text.includes(term)) score += 2;
    for (const term of lowTerms) if (text.includes(term)) score += 1;

    let tendency = 'no';
    if (score >= 6) tendency = 'severe';
    else if (score >= 4) tendency = 'high';
    else if (score >= 2) tendency = 'medium';
    else if (score >= 1) tendency = 'low';

    // Counselling recommendation
    let needsCounselling = 'no';
    if (tendency === 'severe' || tendency === 'high') needsCounselling = 'yes';
    else if (tendency === 'medium') needsCounselling = 'advised';

    // If Gemini is available, ask it to produce a calibrated review and labels
    if (gemini && transcriptText && transcriptText.trim().length > 0) {
        try {
            const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
            const prompt = `You are assessing a phone conversation transcript for suicidal risk in Indian context. 
Return a compact JSON with keys: tendency one of ["no","low","medium","high","severe"], counselling one of ["no","advised","yes"], review a 1-2 sentence summary for a dashboard.
Transcript: """
${transcriptText || ''}
"""`;
            const result = await model.generateContent(prompt);
            const textOut = result.response.text();
            try {
                const parsed = JSON.parse(textOut);
                const tendencyGem = parsed.tendency || 'no';
                const needs = parsed.counselling || 'no';
                const review = parsed.review || '';
                return { tendency: tendencyGem, needsCounselling: needs, review, score };
            } catch (_) {
                // fall through to rule-based review when JSON not parseable
                console.warn('Failed to parse Gemini JSON response');
            }
        } catch (e) {
            console.warn('Gemini classification failed; using rule-based fallback:', e);
        }
    }

    // Lightweight AI-style review summary (rule-based fallback)
    const review = (() => {
        if (tendency === 'severe') return 'Immediate risk indicators present. Prioritize safety planning and emergency resources.';
        if (tendency === 'high') return 'High risk signals detected. Encourage urgent professional support and monitoring.';
        if (tendency === 'medium') return 'Moderate distress. Suggest counselling and coping strategies, schedule follow-up.';
        if (tendency === 'low') return 'Mild distress. Provide support, active listening, and self-care guidance.';
        return 'No risk indicators detected. Maintain supportive, empathetic tone.';
    })();

    return { tendency, needsCounselling, review, score };
}

// Create Ultravox call and get join URL
async function createUltravoxCall(config = ULTRAVOX_CALL_CONFIG) {
    return new Promise((resolve, reject) => {
        // Validate required config
        if (!ULTRAVOX_API_KEY) {
            reject(new Error('ULTRAVOX_API_KEY is required'));
            return;
        }

        const postData = JSON.stringify(config);
        console.log('Creating Ultravox call with config:', JSON.stringify(config, null, 2));

        const request = https.request(ULTRAVOX_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ULTRAVOX_API_KEY,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000 // 10 second timeout
        });

        let data = '';

        request.on('response', (response) => {
            console.log(`Ultravox API response status: ${response.statusCode}`);
            console.log('Response headers:', response.headers);
            
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                console.log('Ultravox API response body:', data);
                try {
                    const parsed = JSON.parse(data || '{}');
                    if (response.statusCode >= 400) {
                        reject(new Error(`Ultravox API error ${response.statusCode}: ${data}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    console.error('Failed parsing Ultravox response:', e, data);
                    reject(new Error(`Failed to parse Ultravox response: ${data}`));
                }
            });
        });

        request.on('error', (error) => {
            console.error('Ultravox API request error:', error);
            reject(error);
        });

        request.on('timeout', () => {
            console.error('Ultravox API request timeout');
            request.destroy();
            reject(new Error('Ultravox API request timeout'));
        });

        request.write(postData);
        request.end();
    });
}

// Handle incoming calls
app.post('/incoming', async (req, res) => {
    const startTime = Date.now();
    console.log('=== INCOMING CALL ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request headers:', JSON.stringify(req.headers, null, 2));

    try {
        // Get caller's phone number
        const callerNumber = req.body.From;
        const callSid = req.body.CallSid;
        console.log(`Incoming call from: ${callerNumber}, CallSid: ${callSid}`);

        if (!callerNumber) {
            throw new Error('No caller number found in request');
        }

        // Create dynamic system prompt with caller's number
        const dynamicSystemPrompt = `Your name is Arjun and you're a good friend who's always there to listen and chat. You have a calm and supportive personality, but you're casual and down-to-earth rather than clinical.

IMPORTANT: You must speak in Hindi throughout the entire conversation. Only use English if the caller specifically requests it.

हिंदी में शुरुआत करें: "नमस्ते, मैं अर्जुन हूँ। आप आज कैसे हैं? आप किस बारे में बात करना चाहेंगे?"

IMPORTANT CONTEXT:
- The caller's phone number is: ${callerNumber}
- LISTEN MORE THAN YOU SPEAK - this is the most important rule
- Keep your responses brief and encourage them to talk more
- Never sound like you're reading from a script
- Always respond in Hindi unless specifically asked to speak English

You're here to:
- Be a good listener for whatever is on their mind
- Chat about daily life, relationships, work, or anything else
- Offer a supportive ear without judgment
- Provide friendly perspective when asked

Conversation guidelines:
- Let them direct the conversation - follow their lead
- Ask open-ended questions that encourage them to share more
- Keep your responses short (1-3 sentences whenever possible)
- Use casual, natural Hindi language like you would with a friend
- Wait for them to finish speaking before responding
- Don't fill every silence - comfortable pauses are natural
- If they're venting, simply acknowledge their feelings without rushing to fix things
- Only offer advice if they specifically ask for it

Hindi conversational phrases to use:
- "मैं समझ रहा हूँ..."
- "यह वाकई मुश्किल लगता है..."
- "क्या आप इसके बारे में और बता सकते हैं?"
- "आप इस बारे में क्या सोचते हैं?"
- "अगर आप और बात करना चाहें तो मैं सुनने के लिए हमेशा यहाँ हूँ"

If the caller seems to be in serious distress, gently suggest in Hindi that while you're always here to talk, speaking with someone with professional training might also be helpful.

Remember: Your primary goal is to be a good listener. People often just need someone who will truly hear them out. Always respond in Hindi unless specifically asked to speak English.`;

        // Create an Ultravox call with dynamic prompt
        const callConfig = {
            ...ULTRAVOX_CALL_CONFIG,
            systemPrompt: dynamicSystemPrompt,
            voice: ULTRAVOX_VOICE_ID, // Indian male voice
            medium: {
                twilio: {
                    // Add any Twilio-specific configuration if needed
                }
            }
        };
        
        console.log('Attempting to create Ultravox call...');
        
        // Create Ultravox call with updated config
        const uvxResponse = await createUltravoxCall(callConfig);
        console.log('Ultravox call created successfully:', uvxResponse);
        
        const joinUrl = uvxResponse?.joinUrl;
        const callId = uvxResponse?.id || uvxResponse?.callId;

        if (!joinUrl) {
            throw new Error(`No joinUrl received from Ultravox. Response: ${JSON.stringify(uvxResponse)}`);
        }

        console.log(`Generated joinUrl: ${joinUrl}`);
        console.log(`Call ID: ${callId}`);

        // Create TwiML response
        const twiml = new twilio.twiml.VoiceResponse();
        
        // Add a brief greeting before connecting (optional)
        // twiml.say('Connecting you now...');
        
        // Connect to Ultravox stream
        const connect = twiml.connect();
        connect.stream({
            url: joinUrl,
            name: 'ultravox'
        });

        const twimlString = twiml.toString();
        console.log('Generated TwiML:', twimlString);
        
        // Set proper content type and send response
        res.type('text/xml');
        res.send(twimlString);

        console.log(`Call setup completed in ${Date.now() - startTime}ms`);

        // Pre-create a conversation record with call metadata (non-blocking)
        const record = {
            id: callId || `call_${Date.now()}`,
            twilioCallSid: callSid,
            from: callerNumber,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            transcript: '',
            summary: '',
            tendency: 'no',
            needsCounselling: 'no',
            raw: { uvxResponse, twilioRequest: req.body }
        };
        
        upsertConversation(record).catch(err => 
            console.warn('Failed to pre-create conversation record:', err)
        );

    } catch (error) {
        console.error('Error handling incoming call:', error);
        console.error('Error stack:', error.stack);
        
        // Always send a valid TwiML response to prevent call drops
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say({
            voice: 'alice',
            language: 'en-IN'
        }, 'I apologize, but we are experiencing difficulty connecting your call. Please try again shortly.');
        
        // Optionally redirect to a fallback number or hang up gracefully
        twiml.hangup();
        
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Generic endpoint to receive conversation transcripts (from Ultravox webhook or other source)
// Expected body: { callId, from, transcript, summary }
app.post('/conversations', async (req, res) => {
    try {
        const { callId, from, transcript, summary } = req.body || {};
        console.log('Received conversation data:', { callId, from, transcriptLength: transcript?.length });
        
        if (!callId && !from) {
            return res.status(400).json({ ok: false, error: 'callId or from is required' });
        }

        const existing = await getConversationById(callId);
        const { tendency, needsCounselling, review } = await classifyRiskAndCounselling(transcript || '');
        const record = {
            id: callId || (existing?.id || `call_${Date.now()}`),
            from: from || existing?.from || 'unknown',
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            transcript: transcript || existing?.transcript || '',
            summary: summary || review,
            tendency,
            needsCounselling,
            raw: existing?.raw
        };
        await upsertConversation(record);
        res.json({ ok: true, conversation: record });
    } catch (error) {
        console.error('Error in /conversations endpoint:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Ultravox event webhook (best-effort schema-agnostic)
app.post('/ultravox/events', async (req, res) => {
    try {
        console.log('Received Ultravox event:', JSON.stringify(req.body, null, 2));
        
        const event = req.body || {};
        // Attempt to extract call identity and transcript/summary
        const callId = event.id || event.callId || event.call_id || event.data?.callId;
        const from = event.from || event.caller || event.data?.from;
        const transcript = event.transcript || event.data?.transcript || '';
        const summary = event.summary || event.data?.summary || '';
        const eventType = event.type || event.event_type || 'unknown';

        console.log(`Processing event type: ${eventType} for call: ${callId}`);

        if (!callId && !transcript) {
            console.log('No actionable data in event, acknowledging...');
            return res.json({ ok: true });
        }

        const existing = callId ? await getConversationById(callId) : undefined;
        const { tendency, needsCounselling, review } = await classifyRiskAndCounselling(transcript);
        const record = {
            id: callId || (existing?.id || `call_${Date.now()}`),
            from: from || existing?.from || 'unknown',
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            transcript: transcript || existing?.transcript || '',
            summary: summary || review,
            tendency,
            needsCounselling,
            raw: { ...(existing?.raw || {}), event }
        };
        await upsertConversation(record);
        res.json({ ok: true });
    } catch (error) {
        console.error('Error in Ultravox webhook:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// API to fetch conversations
app.get('/api/conversations', async (_req, res) => {
    try {
        const convs = await getConversations();
        res.json({ ok: true, conversations: convs });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        ok: true, 
        timestamp: new Date().toISOString(),
        env: {
            hasUltravoxKey: !!ULTRAVOX_API_KEY,
            hasMongoUri: !!MONGODB_URI,
            hasGeminiKey: !!GEMINI_API_KEY,
            baseUrl: BASE_URL
        }
    });
});

// Simple dashboard
app.get('/dashboard', async (_req, res) => {
    try {
        const convs = await getConversations();

        const rows = convs.map(c => `
            <tr>
                <td style="font-family:sans-serif;padding:8px;">${c.id}</td>
                <td style="font-family:sans-serif;padding:8px;">${c.from}</td>
                <td style="font-family:sans-serif;padding:8px;">${new Date(c.createdAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;">${new Date(c.updatedAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.tendency)}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.needsCounselling)}</td>
                <td style="font-family:sans-serif;padding:8px;"><a href="/conversations/${encodeURIComponent(c.id)}">View</a></td>
            </tr>
        `).join('');

        const html = `<!doctype html>
        <html>
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Conversations Dashboard</title>
            <style>
                .badge{display:inline-block;padding:2px 8px;border-radius:12px;color:#fff;font-size:12px}
                .no{background:#64748b}
                .low{background:#22c55e}
                .medium{background:#f59e0b}
                .high{background:#ef4444}
                .severe{background:#7f1d1d}
                .yes{background:#ef4444}
                .advised{background:#f59e0b}
            </style>
        </head>
        <body style="margin:24px;font-family:sans-serif;">
            <h2>Conversations Dashboard</h2>
            <p><a href="/health">Health Check</a> | Total Conversations: ${convs.length}</p>
            <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:960px;">
                <thead>
                    <tr>
                        <th style="padding:8px;text-align:left;">ID</th>
                        <th style="padding:8px;text-align:left;">From</th>
                        <th style="padding:8px;text-align:left;">Created</th>
                        <th style="padding:8px;text-align:left;">Updated</th>
                        <th style="padding:8px;text-align:left;">Tendency</th>
                        <th style="padding:8px;text-align:left;">Counselling</th>
                        <th style="padding:8px;text-align:left;">Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </body>
        </html>`;

        res.type('html').send(html);
    } catch (error) {
        console.error('Error rendering dashboard:', error);
        res.status(500).send('Error loading dashboard');
    }
});

// Conversation detail page
app.get('/conversations/:id', (req, res) => {
    const id = req.params.id;
    getConversationById(id).then(c => {
        if (!c) return res.status(404).send('Not found');

    const html = `<!doctype html>
    <html>
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Conversation ${id}</title>
        <style>
            .badge{display:inline-block;padding:2px 8px;border-radius:12px;color:#fff;font-size:12px}
            .no{background:#64748b}
            .low{background:#22c55e}
            .medium{background:#f59e0b}
            .high{background:#ef4444}
            .severe{background:#7f1d1d}
            .yes{background:#ef4444}
            .advised{background:#f59e0b}
        </style>
    </head>
    <body style="margin:24px;font-family:sans-serif;">
        <a href="/dashboard">← Back</a>
        <h2>Conversation ${id}</h2>
        <p><strong>From:</strong> ${c.from}</p>
        <p><strong>Created:</strong> ${new Date(c.createdAt).toLocaleString()}</p>
        <p><strong>Updated:</strong> ${new Date(c.updatedAt).toLocaleString()}</p>
        <p><strong>Tendency:</strong> <span class="badge ${c.tendency}">${c.tendency}</span></p>
        <p><strong>Counselling:</strong> <span class="badge ${c.needsCounselling}">${c.needsCounselling}</span></p>
        <h3>AI Review</h3>
        <p>${(c.summary || '').replace(/</g, '&lt;')}</p>
        <h3>Transcript</h3>
        <pre style="white-space:pre-wrap;">${(c.transcript || '').replace(/</g, '&lt;')}</pre>
        <h3>Raw Data</h3>
        <pre style="white-space:pre-wrap;font-size:12px;">${JSON.stringify(c.raw || {}, null, 2).replace(/</g, '&lt;')}</pre>
    </body>
    </html>`;
        res.type('html').send(html);
    }).catch(err => {
        console.error('Error loading conversation:', err);
        res.status(500).send('Error loading conversation');
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (req.accepts('xml')) {
        // If it's a Twilio webhook, send valid TwiML
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('An error occurred. Please try again.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    } else {
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Start server
app.listen(port, async () => {
    console.log(`=== SERVER STARTING ===`);
    console.log(`Port: ${port}`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Ultravox API URL: ${ULTRAVOX_API_URL}`);
    console.log(`Environment variables check:`);
    console.log(`- ULTRAVOX_API_KEY: ${ULTRAVOX_API_KEY ? 'SET' : 'MISSING'}`);
    console.log(`- MONGODB_URI: ${MONGODB_URI ? 'SET' : 'NOT SET (using JSON file)'}`);
    console.log(`- GEMINI_API_KEY: ${GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);
    console.log(`- BASE_URL: ${BASE_URL}`);
    
    if (!ULTRAVOX_API_KEY) {
        console.error('❌ CRITICAL: ULTRAVOX_API_KEY is missing! Calls will fail.');
    }
    
    try {
        await initMongo();
        console.log('✅ Database initialization completed');
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
    }
    
    console.log(`✅ Server running successfully on port ${port}`);
    console.log(`Dashboard available at: ${BASE_URL}/dashboard`);
    console.log(`Health check at: ${BASE_URL}/health`);
    console.log(`=== SERVER READY ===`);
});