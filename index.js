import express from 'express';
import https from 'https';
import twilio from 'twilio';
import fs from 'fs';
import path from 'path';
import 'dotenv/config'
import { MongoClient } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const port = Number(process.env.PORT || 5000);

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
    // eventWebhookUrl is not a valid field for StartCallRequest and has been removed
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
    const classes = ['no','low','medium','high','severe','yes','advised','active','completed','unknown'];
    const cls = classes.includes(safe) ? safe : 'no';
    return `<span class="badge ${cls}">${safe || 'no'}</span>`;
}

// Enhanced Classification logic
async function classifyRiskAndCounselling(transcriptText) {
    const text = (transcriptText || '').toLowerCase();
    let score = 0;
    let detectedTerms = [];
    
    // Enhanced keyword categories with Hindi support and specific critical terms
    const criticalSevereTerms = [
        'suicide', 'kill myself', 'end my life', 'i want to die', 'hang myself', 'take my own life',
        'marna chahta hun', 'jaan dena', 'suicide karna'
    ];
    
    const severePlanTerms = [
        'jump off', 'overdose', 'self harm', 'self-harm', 'cut myself', 'razor blade', 
        'poison myself', 'gun to my head', 'bought a rope', 'bought pills', 'wrote a note'
    ];
    
    const highTerms = [
        // English terms
        'i am going to', 'i have a plan', 'goodbye forever', 
        'can\'t go on', 'hopeless', 'life is meaningless', 'nothing matters', 'give up completely',
        'no way out', 'trapped forever', 'can\'t escape', 'ready to go', 'final decision',
        'said goodbye', 'planning to end', 'going to jump', 'no reason to live', 'better off dead',
        // Hindi terms
        'koi raah nahi', 'umeed khatam', 'plan bana liya', 'alvida keh diya', 'bass khatam', 'zindagi khatam'
    ];
    
    const mediumTerms = [
        // English terms
        'depressed', 'depression', 'anxious', 'panic', 'can\'t sleep', 'lost interest', 
        'crying a lot', 'worthless', 'feeling empty', 'numb inside', 'constant pain',
        'overwhelming sadness', 'can\'t cope', 'breaking down', 'lost control', 'spiraling',
        'dark thoughts', 'intrusive thoughts', 'mental breakdown', 'emotional pain',
        // Hindi terms
        'pareshan hun', 'depression hai', 'udaas hun', 'ro raha hun', 'kuch samajh nahi aa raha',
        'pareshani hai', 'anxiety hai', 'ghabrat hai', 'dukh hai'
    ];
    
    const lowTerms = [
        // English terms
        'stressed', 'sad', 'lonely', 'down', 'upset', 'tired of everything', 'frustrated',
        'annoyed', 'irritated', 'fed up', 'overwhelmed', 'exhausted', 'burned out',
        'bothered', 'disappointed', 'discouraged', 'moody', 'grumpy',
        // Hindi terms
        'pareshaan', 'gussa', 'tension', 'thak gaya', 'bore ho gaya', 'irritate ho raha',
        'tang aa gaya', 'dimag kharab', 'stress hai'
    ];

    // Count matches and calculate score with weighted logic
    criticalSevereTerms.forEach(term => {
        if (text.includes(term)) {
            score += 8;  // Highest weight for critical severe terms
            detectedTerms.push({ term, category: 'critical_severe' });
        }
    });
    
    severePlanTerms.forEach(term => {
        if (text.includes(term)) {
            score += 6;  // High weight for planning/method terms
            detectedTerms.push({ term, category: 'severe_plan' });
        }
    });
    
    highTerms.forEach(term => {
        if (text.includes(term)) {
            score += 3;  // Keep high term weight
            detectedTerms.push({ term, category: 'high' });
        }
    });
    
    mediumTerms.forEach(term => {
        if (text.includes(term)) {
            score += 2;  // Keep medium term weight
            detectedTerms.push({ term, category: 'medium' });
        }
    });
    
    lowTerms.forEach(term => {
        if (text.includes(term)) {
            score += 1;  // Keep low term weight
            detectedTerms.push({ term, category: 'low' });
        }
    });

    // Enhanced pattern matching for immediate risk context
    const immediateRiskPatterns = [
        /i\s+(am|will|going to)\s+(kill|end|hurt|harm)\s+(my)/i,
        /tonight\s+(i|will|going)/i,
        /(plan|planning)\s+to\s+(die|kill|end)/i,
        /(ready|prepared)\s+to\s+(die|go|leave)/i,
        /going\s+to\s+(jump|hang)/i
    ];
    
    immediateRiskPatterns.forEach(pattern => {
        if (pattern.test(text)) {
            score += 10;  // Maximum score for immediate risk patterns
            detectedTerms.push({ term: 'immediate_risk_pattern', category: 'critical_severe' });
        }
    });

    // Determine risk tendency based on refined score thresholds
    let tendency = 'no';
    if (score >= 10) tendency = 'severe';    // Lower threshold for severe (critical terms or patterns)
    else if (score >= 6) tendency = 'high';  // High risk threshold
    else if (score >= 4) tendency = 'medium'; // Medium risk threshold  
    else if (score >= 1) tendency = 'low';   // Any detected term = low risk

    // Enhanced counselling recommendation
    let needsCounselling = 'no';
    if (tendency === 'severe' || tendency === 'high') needsCounselling = 'yes';
    else if (tendency === 'medium') needsCounselling = 'advised';

    // If Gemini is available, ask it to produce a calibrated review and labels
    let geminiAnalysis = null;
    if (gemini && transcriptText && transcriptText.trim().length > 0) {
        try {
            const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
            const prompt = `Analyze this mental health conversation transcript for suicide risk and counseling needs. The conversation is with Arjun, a supportive Hindi-speaking friend helping someone in distress.

TRANSCRIPT: "${transcriptText}"

Please provide:
1. Risk level (no/low/medium/high/severe)
2. Counseling recommendation (no/advised/yes)
3. Key concerning phrases or patterns you detected
4. Brief explanation of your assessment
5. Immediate intervention needed? (yes/no)
6. Language used (Hindi/English/Mixed)

Consider both English and Hindi expressions of distress, suicidal ideation, hopelessness, and mental health concerns.

Respond in JSON format:
{
  "risk_level": "...",
  "counseling_needed": "...", 
  "concerning_phrases": [...],
  "assessment": "...",
  "immediate_intervention": "...",
  "language": "..."
}`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const aiText = response.text();
            
            // Try to parse JSON response
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                geminiAnalysis = JSON.parse(jsonMatch[0]);
                
                // Override if AI detected higher risk
                if (geminiAnalysis.risk_level === 'severe' && tendency !== 'severe') {
                    tendency = 'severe';
                    needsCounselling = 'yes';
                    score += 3;
                }
                if (geminiAnalysis.counseling_needed === 'yes' && needsCounselling !== 'yes') {
                    needsCounselling = 'yes';
                }
            }
        } catch (e) {
            console.warn('Gemini classification failed; using rule-based fallback:', e);
        }
    }

    // Enhanced review summary with action items
    const review = (() => {
        if (tendency === 'severe') return `🚨 SEVERE RISK DETECTED - Immediate intervention required. Score: ${score}. Terms: ${detectedTerms.map(t => t.term).join(', ')}. Consider emergency services.`;
        if (tendency === 'high') return `⚠️ HIGH RISK - Urgent counseling recommended. Score: ${score}. Monitor closely and provide immediate support resources.`;
        if (tendency === 'medium') return `⚡ MODERATE CONCERN - Professional counseling advised. Score: ${score}. Provide mental health resources and follow up.`;
        if (tendency === 'low') return `💭 MILD DISTRESS - Supportive listening recommended. Score: ${score}. Emotional support and coping strategies helpful.`;
        return 'No significant risk indicators detected. Maintain supportive, empathetic tone.';
    })();

    // Log detailed analysis for monitoring
    console.log(`Risk Analysis - Score: ${score}, Tendency: ${tendency}, Counselling: ${needsCounselling}`);
    console.log(`Detected terms:`, detectedTerms);
    if (geminiAnalysis) console.log(`AI Analysis:`, geminiAnalysis);

    return { 
        tendency, 
        needsCounselling, 
        review, 
        score, 
        detectedTerms,
        geminiAnalysis,
        immediateIntervention: tendency === 'severe' || detectedTerms.some(t => t.category === 'critical_severe') || (geminiAnalysis?.immediate_intervention === 'yes')
    };
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

// Enhanced conversation handling with real-time analysis and alerts
app.post('/conversations', async (req, res) => {
    try {
        const { callId, from, transcript, summary } = req.body || {};
        console.log('Received conversation data:', { callId, from, transcriptLength: transcript?.length });
        
        if (!callId && !from) {
            return res.status(400).json({ ok: false, error: 'callId or from is required' });
        }

        const existing = await getConversationById(callId);
        const analysis = await classifyRiskAndCounselling(transcript || '');
        
        const record = {
            id: callId || (existing?.id || `call_${Date.now()}`),
            from: from || existing?.from || 'unknown',
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            transcript: transcript || existing?.transcript || '',
            summary: summary || analysis.review,
            tendency: analysis.tendency,
            needsCounselling: analysis.needsCounselling,
            score: analysis.score,
            detectedTerms: analysis.detectedTerms,
            immediateIntervention: analysis.immediateIntervention,
            geminiAnalysis: analysis.geminiAnalysis,
            raw: existing?.raw
        };
        
        await upsertConversation(record);

        // Emergency response for severe cases
        if (analysis.immediateIntervention || analysis.tendency === 'severe') {
            console.log(`🚨 EMERGENCY ALERT - Severe risk detected for caller ${from}`);
            console.log(`Risk Score: ${analysis.score}, Detected Terms: ${JSON.stringify(analysis.detectedTerms)}`);
            
            // Send emergency alert (non-blocking)
            sendEmergencyAlert({
                callId: record.id,
                phone: from,
                riskLevel: analysis.tendency,
                score: analysis.score,
                transcript: transcript,
                timestamp: new Date().toISOString()
            }).catch(err => console.error('Emergency alert failed:', err));
        }

        res.json({ ok: true, conversation: record, riskAnalysis: analysis });
    } catch (error) {
        console.error('Error in /conversations endpoint:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Emergency alert function
async function sendEmergencyAlert(alertData) {
    try {
        console.log(`📧 Sending emergency alert for call ${alertData.callId}`);
        
        // Log to file for audit trail
        const alertLog = {
            timestamp: alertData.timestamp,
            callId: alertData.callId,
            phone: alertData.phone,
            riskLevel: alertData.riskLevel,
            score: alertData.score,
            action: 'emergency_alert_triggered'
        };
        
        // You can implement various alert mechanisms:
        
        // 1. Email alert (example placeholder)
        // await sendEmail({
        //     to: 'crisis-team@yourorganization.com',
        //     subject: `🚨 URGENT: High-Risk Call Alert - ${alertData.phone}`,
        //     body: `Emergency intervention may be needed for call ${alertData.callId}...`
        // });
        
        // 2. SMS alert (example placeholder)
        // await sendSMS({
        //     to: '+1234567890', // Crisis counselor number
        //     message: `URGENT: High-risk call detected. Call ID: ${alertData.callId}, Risk: ${alertData.riskLevel}`
        // });
        
        // 3. Slack/Discord webhook (example placeholder)
        // await sendSlackAlert({
        //     channel: '#crisis-alerts',
        //     message: `🚨 EMERGENCY: Severe risk detected for caller ${alertData.phone}...`
        // });
        
        console.log('Emergency alert processing completed');
        
    } catch (error) {
        console.error('Failed to send emergency alert:', error);
    }
}

// Enhanced Ultravox event webhook with real-time risk monitoring
app.post('/ultravox/events', async (req, res) => {
    try {
        console.log('Received Ultravox event:', JSON.stringify(req.body, null, 2));
        
        const event = req.body || {};
        // Extract call data based on Ultravox webhook structure
        const callId = event.id || event.callId || event.call_id || event.data?.callId || event.data?.id;
        const from = event.from || event.caller || event.data?.from || event.data?.caller;
        const eventType = event.type || event.event_type || event.event || 'unknown';
        
        // Handle different Ultravox event types
        console.log(`🔔 Ultravox Event: ${eventType} for call: ${callId}`);

        if (eventType === 'call_started' || eventType === 'start_call') {
            // Initialize call record when call starts
            console.log('📞 Call started - initializing record');
            const record = {
                id: callId || `call_${Date.now()}`,
                from: from || 'unknown',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transcript: '',
                summary: 'Call in progress...',
                tendency: 'no',
                needsCounselling: 'no',
                score: 0,
                detectedTerms: [],
                immediateIntervention: false,
                status: 'active',
                raw: { startEvent: event }
            };
            await upsertConversation(record);
            return res.json({ ok: true, message: 'Call started, tracking initialized' });
        }

        if (eventType === 'call_joined' || eventType === 'joined_call') {
            // Update call record when participants join
            console.log('👥 Participant joined call');
            const existing = callId ? await getConversationById(callId) : null;
            if (existing) {
                existing.updatedAt = new Date().toISOString();
                existing.status = 'participants_joined';
                existing.raw = { ...(existing.raw || {}), joinEvent: event };
                await upsertConversation(existing);
            }
            return res.json({ ok: true, message: 'Call join recorded' });
        }

        if (eventType === 'call_ended' || eventType === 'end_call') {
            // Process final transcript and perform analysis when call ends
            console.log('📞 Call ended - processing final transcript');
            
            // Extract transcript from various possible locations in the event
            const transcript = event.transcript || 
                             event.data?.transcript || 
                             event.messages?.map(m => m.text).join(' ') || 
                             event.conversation || 
                             '';
                             
            const summary = event.summary || event.data?.summary || '';
            
            if (!callId) {
                console.log('⚠️ No call ID in end call event, acknowledging...');
                return res.json({ ok: true, message: 'No call ID provided' });
            }

            const existing = await getConversationById(callId);
            
            // Perform mental health analysis on the final transcript
            const analysis = transcript ? await classifyRiskAndCounselling(transcript) : {
                tendency: 'no',
                needsCounselling: 'no',
                review: 'No transcript available for analysis',
                score: 0,
                detectedTerms: [],
                immediateIntervention: false
            };
            
            const record = {
                id: callId,
                from: from || existing?.from || 'unknown',
                createdAt: existing?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transcript: transcript || existing?.transcript || '',
                summary: summary || analysis.review,
                tendency: analysis.tendency,
                needsCounselling: analysis.needsCounselling,
                score: analysis.score,
                detectedTerms: analysis.detectedTerms,
                immediateIntervention: analysis.immediateIntervention,
                geminiAnalysis: analysis.geminiAnalysis,
                status: 'completed',
                raw: { ...(existing?.raw || {}), endEvent: event }
            };
            
            await upsertConversation(record);

            // Trigger emergency alerts if needed
            if (analysis.immediateIntervention || analysis.tendency === 'severe') {
                console.log(`🚨 POST-CALL EMERGENCY ALERT - Severe risk detected for caller ${from}`);
                sendEmergencyAlert({
                    callId: record.id,
                    phone: from,
                    riskLevel: analysis.tendency,
                    score: analysis.score,
                    transcript: transcript,
                    timestamp: new Date().toISOString(),
                    isPostCall: true
                }).catch(err => console.error('Post-call emergency alert failed:', err));
            }

            console.log(`✅ Call analysis complete - Risk: ${analysis.tendency}, Score: ${analysis.score}`);
            return res.json({ ok: true, riskAnalysis: analysis, message: 'Call ended and analyzed' });
        }

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

// Enhanced dashboard with detailed risk analysis
app.get('/dashboard', async (_req, res) => {
    try {
        const convs = await getConversations();

        const rows = convs.map(c => `
            <tr ${c.immediateIntervention ? 'style="background-color:#fef2f2;border-left:4px solid #dc2626;"' : ''}>
                <td style="font-family:sans-serif;padding:8px;">${c.id}</td>
                <td style="font-family:sans-serif;padding:8px;">${c.from}</td>
                <td style="font-family:sans-serif;padding:8px;">${new Date(c.createdAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;">${new Date(c.updatedAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.status || 'unknown')}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.tendency)}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.needsCounselling)}</td>
                <td style="font-family:sans-serif;padding:8px;text-align:center;">${c.score || 0}</td>
                <td style="font-family:sans-serif;padding:8px;text-align:center;">${c.immediateIntervention ? '🚨' : '-'}</td>
                <td style="font-family:sans-serif;padding:8px;"><a href="/conversations/${encodeURIComponent(c.id)}">View</a></td>
            </tr>
        `).join('');

        const emergencyCount = convs.filter(c => c.immediateIntervention || c.tendency === 'severe').length;
        const highRiskCount = convs.filter(c => c.tendency === 'high').length;

        const html = `<!doctype html>
        <html>
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Mental Health Monitoring Dashboard</title>
            <style>
                .badge{display:inline-block;padding:2px 8px;border-radius:12px;color:#fff;font-size:12px}
                .no{background:#64748b}
                .low{background:#22c55e}
                .medium{background:#f59e0b}
                .high{background:#ef4444}
                .severe{background:#7f1d1d}
                .yes{background:#ef4444}
                .advised{background:#f59e0b}
                .active{background:#3b82f6}
                .completed{background:#10b981}
                .unknown{background:#6b7280}
                .stats{display:flex;gap:20px;margin:20px 0;}
                .stat-card{background:#f8f9fa;padding:15px;border-radius:8px;text-align:center;min-width:120px;}
                .stat-number{font-size:24px;font-weight:bold;color:#333;}
                .stat-label{font-size:14px;color:#666;}
                .emergency{background:#fee2e2;border-left:4px solid #dc2626;}
            </style>
        </head>
        <body style="margin:24px;font-family:sans-serif;">
            <h2>🧠 Mental Health Monitoring Dashboard</h2>
            <p><a href="/health">Health Check</a> | <a href="/api/conversations">API</a></p>
            
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-number">${convs.length}</div>
                    <div class="stat-label">Total Calls</div>
                </div>
                <div class="stat-card emergency">
                    <div class="stat-number">${emergencyCount}</div>
                    <div class="stat-label">🚨 Emergency</div>
                </div>
                <div class="stat-card" style="background:#fef3c7;">
                    <div class="stat-number">${highRiskCount}</div>
                    <div class="stat-label">⚠️ High Risk</div>
                </div>
            </div>
            
            <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:1200px;margin-top:20px;">
                <thead style="background:#f1f5f9;">
                    <tr>
                        <th style="padding:8px;text-align:left;">Call ID</th>
                        <th style="padding:8px;text-align:left;">Phone</th>
                        <th style="padding:8px;text-align:left;">Started</th>
                        <th style="padding:8px;text-align:left;">Updated</th>
                        <th style="padding:8px;text-align:left;">Status</th>
                        <th style="padding:8px;text-align:left;">Risk Level</th>
                        <th style="padding:8px;text-align:left;">Counselling</th>
                        <th style="padding:8px;text-align:left;">Score</th>
                        <th style="padding:8px;text-align:left;">Alert</th>
                        <th style="padding:8px;text-align:left;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
            
            <div style="margin-top:20px;padding:15px;background:#f0f9ff;border-radius:8px;">
                <h4>Legend:</h4>
                <p><strong>Risk Levels:</strong> ${badge('no')} No Risk | ${badge('low')} Low | ${badge('medium')} Medium | ${badge('high')} High | ${badge('severe')} Severe</p>
                <p><strong>Counselling:</strong> ${badge('no')} Not Needed | ${badge('advised')} Recommended | ${badge('yes')} Urgent</p>
                <p><strong>🚨 Alert:</strong> Indicates immediate intervention may be needed</p>
            </div>
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