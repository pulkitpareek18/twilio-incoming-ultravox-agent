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
const ULTRAVOX_API_URL = 'https://api.ultravox.ai/api/calls'; // Standardized base URL
const ULTRAVOX_MODEL = process.env.ULTRAVOX_MODEL || 'fixie-ai/ultravox';
const ULTRAVOX_VOICE_ID = process.env.ULTRAVOX_VOICE_ID || '9f6262e3-1b03-4a0b-9921-50b9cff66a43';
const ULTRAVOX_TEMPERATURE = Number(process.env.ULTRAVOX_TEMPERATURE || '0.7');
const FIRST_SPEAKER = process.env.FIRST_SPEAKER || 'FIRST_SPEAKER_AGENT';

// Webhook base URL to receive Ultravox events (set to your public URL)
const BASE_URL = process.env.BASE_URL || 'https://twilio-incoming-ultravox-agent.onrender.com';

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
    voice: ULTRAVOX_VOICE_ID,
    temperature: ULTRAVOX_TEMPERATURE,
    firstSpeaker: FIRST_SPEAKER,
    medium: { twilio: {} },
    recordingEnabled: true,
    transcriptOptional: false,
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

// Fallback JSON file store
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
            return await conversationsCol.find({}).sort({ updatedAt: -1 }).toArray();
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
    const classes = ['no','low','medium','high','severe','yes','advised','active','completed','unknown', 'imported', 'imported_updated', 'no_transcript'];
    const cls = classes.includes(safe) ? safe : 'unknown';
    return `<span class="badge ${cls}">${safe || 'unknown'}</span>`;
}

// Enhanced Risk Classification with Gemini
async function classifyRiskAndCounselling(transcriptText) {
    const text = (transcriptText || '').toLowerCase();
    let score = 0;
    let detectedTerms = [];
    
    // --- Keyword detection logic remains the same ---
    const criticalSevereTerms = ['suicide', 'kill myself', 'end my life', 'i want to die', 'hang myself', 'take my own life', 'marna chahta hun', 'jaan dena', 'suicide karna'];
    const severePlanTerms = ['jump off', 'overdose', 'self harm', 'self-harm', 'cut myself', 'razor blade', 'poison myself', 'gun to my head', 'bought a rope', 'bought pills', 'wrote a note'];
    const highTerms = ['i am going to', 'i have a plan', 'goodbye forever', 'can\'t go on', 'hopeless', 'life is meaningless', 'nothing matters', 'give up completely', 'no way out', 'trapped forever', 'can\'t escape', 'ready to go', 'final decision', 'said goodbye', 'planning to end', 'going to jump', 'no reason to live', 'better off dead', 'koi raah nahi', 'umeed khatam', 'plan bana liya', 'alvida keh diya', 'bass khatam', 'zindagi khatam'];
    const mediumTerms = ['depressed', 'depression', 'anxious', 'panic', 'can\'t sleep', 'lost interest', 'crying a lot', 'worthless', 'feeling empty', 'numb inside', 'constant pain', 'overwhelming sadness', 'can\'t cope', 'breaking down', 'lost control', 'spiraling', 'dark thoughts', 'intrusive thoughts', 'mental breakdown', 'emotional pain', 'pareshan hun', 'depression hai', 'udaas hun', 'ro raha hun', 'kuch samajh nahi aa raha', 'pareshani hai', 'anxiety hai', 'ghabrat hai', 'dukh hai'];
    const lowTerms = ['stressed', 'sad', 'lonely', 'down', 'upset', 'tired of everything', 'frustrated', 'annoyed', 'irritated', 'fed up', 'overwhelmed', 'exhausted', 'burned out', 'bothered', 'disappointed', 'discouraged', 'moody', 'grumpy', 'pareshaan', 'gussa', 'tension', 'thak gaya', 'bore ho gaya', 'irritate ho raha', 'tang aa gaya', 'dimag kharab', 'stress hai'];
    criticalSevereTerms.forEach(term => { if (text.includes(term)) { score += 8; detectedTerms.push({ term, category: 'critical_severe' }); } });
    severePlanTerms.forEach(term => { if (text.includes(term)) { score += 6; detectedTerms.push({ term, category: 'severe_plan' }); } });
    highTerms.forEach(term => { if (text.includes(term)) { score += 3; detectedTerms.push({ term, category: 'high' }); } });
    mediumTerms.forEach(term => { if (text.includes(term)) { score += 2; detectedTerms.push({ term, category: 'medium' }); } });
    lowTerms.forEach(term => { if (text.includes(term)) { score += 1; detectedTerms.push({ term, category: 'low' }); } });
    const immediateRiskPatterns = [/i\s+(am|will|going to)\s+(kill|end|hurt|harm)\s+(my)/i, /tonight\s+(i|will|going)/i, /(plan|planning)\s+to\s+(die|kill|end)/i, /(ready|prepared)\s+to\s+(die|go|leave)/i, /going\s+to\s+(jump|hang)/i];
    immediateRiskPatterns.forEach(pattern => { if (pattern.test(text)) { score += 10; detectedTerms.push({ term: 'immediate_risk_pattern', category: 'critical_severe' }); } });
    
    let tendency = 'no';
    if (score >= 10) tendency = 'severe'; else if (score >= 6) tendency = 'high'; else if (score >= 4) tendency = 'medium'; else if (score >= 1) tendency = 'low';
    
    let needsCounselling = 'no';
    if (tendency === 'severe' || tendency === 'high') needsCounselling = 'yes'; else if (tendency === 'medium') needsCounselling = 'advised';

    let geminiAnalysis = null;
    // --- ✅ Gemini Analysis Logic ---
    if (gemini && transcriptText && transcriptText.trim().length > 50) { // Only run for reasonably long transcripts
        try {
            console.log('🤖 Starting Gemini analysis...');
            const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
            const prompt = `
                Analyze the following conversation transcript for mental health risks. The user is talking to a supportive friend AI named Arjun.
                The conversation is primarily in Hindi.
                Provide your analysis ONLY in a valid JSON format. Do not include any text before or after the JSON object.
                
                The JSON object must have these exact keys:
                - "risk_level": (string) Classify the risk as "no", "low", "medium", "high", or "severe".
                - "counseling_needed": (string) Recommend counseling as "no", "advised", or "yes".
                - "immediate_intervention": (string) State "yes" if there are signs of immediate self-harm plans, otherwise "no".
                - "emotional_state": (string) A brief description of the user's likely emotional state (e.g., "Stressed and overwhelmed", "Feeling lonely and sad", "Exhibiting signs of severe depression").
                - "concerning_phrases": (array of strings) Extract up to 5 direct quotes from the user that are most concerning.
                - "assessment_summary": (string) A concise one-paragraph summary of your analysis and the reasoning for the risk level.
                - "confidence_level": (string) Your confidence in this analysis ("low", "medium", "high").
                - "language_used": (string) The primary language detected ("hindi", "english", "hinglish").
                - "support_recommendations": (string) Suggest one brief, actionable step for the support agent (e.g., "Advise professional help", "Continue to listen and provide support", "Gently probe about their support system").
                
                Transcript:
                ---
                ${transcriptText}
                ---
            `;
            const result = await model.generateContent(prompt);
            const responseText = result.response.text().trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
            geminiAnalysis = JSON.parse(responseText);
            console.log('✅ Gemini analysis successful.');
        } catch (e) {
            console.warn('Gemini classification failed:', e);
            geminiAnalysis = { error: e.message };
        }
    }
    
    const review = (() => { if (tendency === 'severe') return `🚨 SEVERE RISK DETECTED...`; if (tendency === 'high') return `⚠️ HIGH RISK...`; if (tendency === 'medium') return `⚡ MODERATE CONCERN...`; if (tendency === 'low') return `💭 MILD DISTRESS...`; return 'No significant risk indicators detected.'; })();
    
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

// --- Corrected Ultravox API Functions ---

/**
 * Helper function to make requests to the Ultravox API.
 */
async function requestUltravoxAPI(url, options) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, options, (response) => {
            let data = '';
            response.on('data', (chunk) => (data += chunk));
            response.on('end', () => {
                console.log(`Ultravox API response from ${url}: ${response.statusCode}`);
                if (response.statusCode >= 400) {
                    console.error(`Ultravox API Error: ${response.statusCode}`, data);
                    reject(new Error(`API error ${response.statusCode}: ${data}`));
                } else {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch (e) {
                        console.error('Failed to parse Ultravox JSON response:', e, data);
                        reject(new Error('Failed to parse JSON response.'));
                    }
                }
            });
        });
        request.on('error', (error) => {
            console.error(`Ultravox API request error for ${url}:`, error);
            reject(error);
        });
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Request timed out.'));
        });
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}

/**
 * Creates a new call session with Ultravox.
 */
async function createUltravoxCall(config = ULTRAVOX_CALL_CONFIG) {
    if (!ULTRAVOX_API_KEY) throw new Error('ULTRAVOX_API_KEY is required');
    const postData = JSON.stringify(config);
    console.log('Creating Ultravox call with config:', postData);
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': ULTRAVOX_API_KEY,
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000,
        body: postData,
    };
    return requestUltravoxAPI(ULTRAVOX_API_URL, options);
}

/**
 * Retrieves the main call object from Ultravox (for metadata and recordingUrl).
 */
async function getUltravoxCall(callId) {
    if (!ULTRAVOX_API_KEY) throw new Error('ULTRAVOX_API_KEY is required');
    const url = `${ULTRAVOX_API_URL}/${callId}`;
    console.log(`Fetching call details from: ${url}`);
    const options = {
        method: 'GET',
        headers: { 'X-API-Key': ULTRAVOX_API_KEY },
        timeout: 15000,
    };
    return requestUltravoxAPI(url, options);
}

/**
 * Retrieves messages for a call and formats them into a transcript.
 */
async function getUltravoxTranscriptFromMessages(callId) {
    if (!ULTRAVOX_API_KEY) throw new Error('ULTRAVOX_API_KEY is required');
    const url = `${ULTRAVOX_API_URL}/${callId}/messages`;
    console.log(`Fetching messages for transcript from: ${url}`);
    const options = {
        method: 'GET',
        headers: { 'X-API-Key': ULTRAVOX_API_KEY },
        timeout: 15000,
    };
    const messagesResponse = await requestUltravoxAPI(url, options);
    if (messagesResponse.results && Array.isArray(messagesResponse.results)) {
        return messagesResponse.results
            .filter(msg => msg.text && msg.text.trim())
            .map(msg => `${msg.role === 'MESSAGE_ROLE_USER' ? 'User' : 'Agent'}: ${msg.text}`)
            .join('\n');
    }
    return '';
}

// Helper to find our conversation record using Twilio's CallSid
async function findConversationByTwilioSid(twilioCallSid) {
    try {
        if (conversationsCol) {
            return await conversationsCol.findOne({ twilioCallSid: twilioCallSid });
        }
        const list = await getConversations();
        return list.find(x => x.twilioCallSid === twilioCallSid);
    } catch (error) {
        console.error('Failed to get conversation by Twilio SID:', error);
        return null;
    }
}

// --- Express Endpoints ---

// Handle incoming calls
app.post('/incoming', async (req, res) => {
    console.log('=== INCOMING CALL ===', req.body);
    try {
        const callerNumber = req.body.From;
        const callSid = req.body.CallSid;
        if (!callerNumber) throw new Error('No caller number found in request');
        
        const uvxResponse = await createUltravoxCall(ULTRAVOX_CALL_CONFIG);
        console.log('Ultravox response structure:', JSON.stringify(uvxResponse, null, 2));

        // ✅ FIX: Handle different possible response structures
        let joinUrl, callId;
        
        if (uvxResponse.call) {
            // If response has nested 'call' object (webhook structure)
            joinUrl = uvxResponse.call.joinUrl;
            callId = uvxResponse.call.callId;
        } else if (uvxResponse.joinUrl) {
            // If response has direct properties (API response structure)
            joinUrl = uvxResponse.joinUrl;
            callId = uvxResponse.callId;
        } else {
            console.error('Unexpected response structure from Ultravox:', uvxResponse);
            throw new Error('Invalid response structure from Ultravox API');
        }

        if (!joinUrl || !callId) {
            console.error('Missing joinUrl or callId in response:', { joinUrl, callId, uvxResponse });
            throw new Error('Missing required fields (joinUrl, callId) in Ultravox response');
        }

        console.log(`Connecting call ${callSid} to Ultravox call ${callId}`);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.connect().stream({ url: joinUrl });
        res.type('text/xml').send(twiml.toString());

        // Store the conversation record
        upsertConversation({
            id: callId,
            twilioCallSid: callSid,
            from: callerNumber,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
            raw: { uvxResponse, twilioRequest: req.body }
        });
    } catch (error) {
        console.error('Error handling incoming call:', error);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say({ voice: 'alice', language: 'en-IN' }, 'We are experiencing difficulty connecting your call. Please try again shortly.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    }
});

// Emergency alert function
async function sendEmergencyAlert(alertData) {
    console.log(`🚨 EMERGENCY ALERT TRIGGERED for call ${alertData.callId}`);
    // Placeholder for actual alert integrations (email, SMS, etc.)
}

// Handle Ultravox event webhooks
app.post('/ultravox/events', async (req, res) => {
    console.log('Received Webhook Event:', JSON.stringify(req.body, null, 2));
    const event = req.body || {};

    const callId = event.call?.callId || req.body.ParentCallSid || req.body.CallSid;
    const eventType = event.event || req.body.CallStatus; // 'call.ended' or 'completed'

    if (!callId) {
        console.warn('Webhook event received without a CallSid or call.callId.');
        return res.status(200).json({ ok: true, message: 'Event acknowledged, no Call ID found.' });
    }
    
    // Acknowledge the webhook immediately
    res.status(200).json({ ok: true, message: `Event '${eventType}' acknowledged.` });

    // For Twilio, the final status is 'completed'. For Ultravox, it's 'call.ended'.
    if (eventType === 'completed' || eventType === 'call.ended') {
        console.log(`📞 Call ended for ${callId} - processing transcript and recording.`);
        try {
            // We need to look up our record by Twilio's SID to get the Ultravox Call ID.
            const existing = await findConversationByTwilioSid(callId);
            if (!existing) {
                console.error(`Could not find a record for Twilio CallSid: ${callId}`);
                return;
            }

            const ultravoxCallId = existing.id;

            const [transcriptResult, callDetailsResult] = await Promise.allSettled([
                getUltravoxTranscriptFromMessages(ultravoxCallId),
                getUltravoxCall(ultravoxCallId),
            ]);
            
            const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : '';
            const callDetails = callDetailsResult.status === 'fulfilled' ? callDetailsResult.value : null;

            if (transcriptResult.status === 'rejected') console.warn(`Failed to fetch transcript for ${callId}:`, transcriptResult.reason.message);
            if (callDetailsResult.status === 'rejected') console.warn(`Failed to fetch call details for ${callId}:`, callDetailsResult.reason.message);

            const analysis = await classifyRiskAndCounselling(transcript || 'No transcript available');
            
            const record = {
                ...existing,
                updatedAt: new Date().toISOString(),
                transcript,
                recordingUrl: callDetails?.recordingUrl || existing.recordingUrl || '',
                summary: analysis.review,
                tendency: analysis.tendency,
                needsCounselling: analysis.needsCounselling,
                score: analysis.score,
                detectedTerms: analysis.detectedTerms,
                immediateIntervention: analysis.immediateIntervention,
                geminiAnalysis: analysis.geminiAnalysis,
                status: 'completed',
                raw: { ...(existing.raw || {}), endEvent: event, finalDetails: callDetails }
            };
            
            await upsertConversation(record);
            if (record.immediateIntervention) await sendEmergencyAlert(record);
            console.log(`✅ Final processing complete for call ${callId}.`);
        } catch (error) {
            console.error(`Error processing call_ended event for ${callId}:`, error);
        }
    }
});

// API to fetch all conversations
app.get('/api/conversations', async (_req, res) => {
    try {
        const convs = await getConversations();
        res.json({ ok: true, conversations: convs });
    } catch (error) {
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Manual endpoint to refresh a specific conversation's transcript and recording
app.post('/api/conversations/:id/refresh', async (req, res) => {
    try {
        const { id: callId } = req.params;
        console.log(`🔄 Manual refresh requested for conversation: ${callId}`);
        const existing = await getConversationById(callId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Conversation not found' });

        const [transcriptResult, callDetailsResult] = await Promise.allSettled([
            getUltravoxTranscriptFromMessages(callId),
            getUltravoxCall(callId),
        ]);

        const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : existing.transcript || '';
        const callDetails = callDetailsResult.status === 'fulfilled' ? callDetailsResult.value : null;
        const transcriptUpdated = transcriptResult.status === 'fulfilled' && !!transcriptResult.value;

        const analysis = await classifyRiskAndCounselling(transcript || 'No transcript available');
        const updatedRecord = {
            ...existing,
            updatedAt: new Date().toISOString(),
            transcript,
            summary: analysis.review,
            tendency: analysis.tendency,
            needsCounselling: analysis.needsCounselling,
            score: analysis.score,
            detectedTerms: analysis.detectedTerms,
            immediateIntervention: analysis.immediateIntervention,
            geminiAnalysis: analysis.geminiAnalysis,
            recordingUrl: callDetails?.recordingUrl || existing.recordingUrl || '',
            status: transcript ? 'completed' : 'no_transcript'
        };
        await upsertConversation(updatedRecord);
        
        console.log(`✅ Conversation refresh complete for ${callId}`);
        res.json({ 
            ok: true, 
            conversation: updatedRecord, 
            message: transcriptUpdated ? 'Transcript fetched and analysis updated' : 'Analysis updated with existing data'
        });
    } catch (error) {
        console.error('Error refreshing conversation:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Endpoint to regenerate AI analysis for a specific conversation
app.post('/api/conversations/:id/regenerate-analysis', async (req, res) => {
    try {
        const { id: callId } = req.params;
        console.log(`🤖 Regenerating AI analysis for conversation: ${callId}`);
        const existing = await getConversationById(callId);

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'Conversation not found' });
        }

        if (!existing.transcript || existing.transcript.trim().length === 0) {
            return res.status(400).json({ ok: false, error: 'Cannot regenerate analysis without a transcript.' });
        }

        // Re-run the full analysis, which includes the Gemini call
        const analysis = await classifyRiskAndCounselling(existing.transcript);

        const updatedRecord = {
            ...existing,
            updatedAt: new Date().toISOString(),
            summary: analysis.review,
            tendency: analysis.tendency,
            needsCounselling: analysis.needsCounselling,
            score: analysis.score,
            detectedTerms: analysis.detectedTerms,
            immediateIntervention: analysis.immediateIntervention,
            geminiAnalysis: analysis.geminiAnalysis,
        };
        
        await upsertConversation(updatedRecord);
        
        console.log(`✅ AI Analysis regeneration complete for ${callId}`);
        res.json({ 
            ok: true, 
            conversation: updatedRecord, 
            message: 'AI analysis has been successfully regenerated.' 
        });
    } catch (error) {
        console.error('Error regenerating AI analysis:', error);
        res.status(500).json({ ok: false, error: 'Internal server error during analysis regeneration.' });
    }
});

// Batch refresh endpoint to update all conversations missing transcripts
app.post('/api/conversations/refresh-all', async (req, res) => {
    try {
        console.log('🔄 Batch refresh requested for all conversations');
        const conversations = await getConversations();
        const results = [];
        
        for (const conv of conversations) {
            if (!conv.transcript || conv.transcript.trim().length === 0) {
                console.log(`🔄 Refreshing conversation ${conv.id}...`);
                try {
                    const [transcriptResult, callDetailsResult] = await Promise.allSettled([
                        getUltravoxTranscriptFromMessages(conv.id),
                        getUltravoxCall(conv.id),
                    ]);

                    const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : '';
                    const callDetails = callDetailsResult.status === 'fulfilled' ? callDetailsResult.value : null;

                    const analysis = await classifyRiskAndCounselling(transcript || 'No transcript available');
                    const updatedRecord = {
                        ...conv,
                        updatedAt: new Date().toISOString(),
                        transcript,
                        recordingUrl: callDetails?.recordingUrl || conv.recordingUrl || '',
                        summary: analysis.review,
                        tendency: analysis.tendency,
                        needsCounselling: analysis.needsCounselling,
                        score: analysis.score,
                        detectedTerms: analysis.detectedTerms,
                        immediateIntervention: analysis.immediateIntervention,
                        geminiAnalysis: analysis.geminiAnalysis
                    };

                    await upsertConversation(updatedRecord);
                    results.push({ id: conv.id, status: 'updated', transcriptLength: transcript.length });
                } catch (error) {
                    console.error(`Failed to refresh conversation ${conv.id}:`, error);
                    results.push({ id: conv.id, status: 'failed', error: error.message });
                }
            } else {
                results.push({ id: conv.id, status: 'skipped', reason: 'already has transcript' });
            }
        }
        
        console.log(`✅ Batch refresh complete - processed ${results.length} conversations`);
        res.json({ ok: true, results, message: `Processed ${results.length} conversations` });
    } catch (error) {
        console.error('Error in batch refresh:', error);
        res.status(500).json({ ok: false, error: 'Internal server error' });
    }
});

// Import actual calls from Ultravox endpoint
app.post('/api/conversations/import-from-ultravox', async (req, res) => {
    try {
        console.log('📥 Starting import of calls from Ultravox...');
        const limit = parseInt(req.body.limit) || 20;

        async function listUltravoxCalls(limit = 50) {
            if (!ULTRAVOX_API_KEY) throw new Error('ULTRAVOX_API_KEY is required');
            const url = `${ULTRAVOX_API_URL}?limit=${limit}`;
            const options = {
                method: 'GET',
                headers: { 'X-API-Key': ULTRAVOX_API_KEY },
                timeout: 15000,
            };
            return requestUltravoxAPI(url, options);
        }

        const callsResponse = await listUltravoxCalls(limit);
        const calls = callsResponse.results || [];
        console.log(`📋 Fetched ${calls.length} calls from Ultravox`);
        const results = [];
        
        for (const call of calls) {
            try {
                const callId = call.id || call.callId;
                if (!callId) {
                    results.push({ id: 'unknown', status: 'skipped', message: 'No call ID found' });
                    continue;
                }
                
                const [transcriptResult, callDetailsResult] = await Promise.allSettled([
                    getUltravoxTranscriptFromMessages(callId),
                    getUltravoxCall(callId),
                ]);

                const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : '';
                const callDetails = callDetailsResult.status === 'fulfilled' ? callDetailsResult.value : null;

                const analysis = await classifyRiskAndCounselling(transcript || 'Imported call - no transcript');
                const existing = await getConversationById(callId);
                
                const record = {
                    ...(existing || {}),
                    id: callId,
                    from: callDetails?.from || call.from || 'unknown',
                    createdAt: call.createdAt || call.created_at || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    transcript,
                    recordingUrl: callDetails?.recordingUrl || '',
                    summary: analysis.review,
                    tendency: analysis.tendency,
                    needsCounselling: analysis.needsCounselling,
                    score: analysis.score,
                    detectedTerms: analysis.detectedTerms,
                    immediateIntervention: analysis.immediateIntervention,
                    geminiAnalysis: analysis.geminiAnalysis,
                    status: existing ? 'imported_updated' : 'imported',
                    raw: { ...(existing?.raw || {}), importedCall: call, importedDetails: callDetails }
                };
                
                await upsertConversation(record);
                results.push({ id: callId, status: existing ? 'updated' : 'created', message: 'Call data processed' });
            } catch (callError) {
                console.error(`Error processing call ${call.id}:`, callError);
                results.push({ id: call.id || 'unknown', status: 'error', message: callError.message });
            }
        }
        
        const created = results.filter(r => r.status === 'created').length;
        const updated = results.filter(r => r.status === 'updated').length;
        console.log(`📥 Import complete: ${created} created, ${updated} updated.`);
        res.json({ ok: true, summary: { created, updated }, results });
    } catch (error) {
        console.error('Error during import:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Cleanup invalid calls endpoint
app.post('/api/conversations/cleanup-invalid', async (req, res) => {
    try {
        console.log('🧹 Starting cleanup of invalid calls...');
        const conversations = await getConversations();
        const results = [];
        
        for (const conv of conversations) {
            try {
                await getUltravoxCall(conv.id);
                results.push({ id: conv.id, status: 'valid' });
            } catch (error) {
                if (error.message.includes('404')) {
                    results.push({ id: conv.id, status: 'invalid', message: 'Not found in Ultravox' });
                } else {
                    results.push({ id: conv.id, status: 'error', message: error.message });
                }
            }
        }
        
        const invalidCount = results.filter(r => r.status === 'invalid').length;
        console.log(`🧹 Cleanup complete: Found ${invalidCount} invalid calls.`);
        res.json({ ok: true, summary: { invalid: invalidCount }, results });
    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Enhanced dashboard with detailed risk analysis
app.get('/dashboard', async (_req, res) => {
    try {
        const convs = await getConversations();

        const rows = convs.map(c => {
            const hasTranscript = c.transcript && c.transcript.trim().length > 0;
            const transcriptStatus = hasTranscript ? 
                `${c.transcript.length} chars` : 
                '<span style="color:#dc2626;">No transcript</span>';
            
            const hasRecording = c.recordingUrl && c.recordingUrl.trim().length > 0;
            const recordingStatus = hasRecording ? 
                `<a href="${c.recordingUrl}" target="_blank" style="color:#059669;text-decoration:none;" title="Play Recording">🎵 Audio</a>` : 
                '<span style="color:#dc2626;">No recording</span>';
                
            return `
            <tr ${c.immediateIntervention ? 'style="background-color:#fef2f2;border-left:4px solid #dc2626;"' : ''}>
                <td style="font-family:sans-serif;padding:8px;font-size:12px;">${c.id.substring(0, 8)}...</td>
                <td style="font-family:sans-serif;padding:8px;">${c.from}</td>
                <td style="font-family:sans-serif;padding:8px;font-size:12px;">${new Date(c.createdAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;font-size:12px;">${new Date(c.updatedAt).toLocaleString()}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.status || 'unknown')}</td>
                <td style="font-family:sans-serif;padding:8px;">${transcriptStatus}</td>
                <td style="font-family:sans-serif;padding:8px;">${recordingStatus}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.tendency)}</td>
                <td style="font-family:sans-serif;padding:8px;">${badge(c.needsCounselling)}</td>
                <td style="font-family:sans-serif;padding:8px;text-align:center;">${c.score || 0}</td>
                <td style="font-family:sans-serif;padding:8px;text-align:center;">${c.immediateIntervention ? '🚨' : '-'}</td>
                <td style="font-family:sans-serif;padding:8px;text-align:center;">${c.geminiAnalysis ? '✅' : '❌'}</td>
                <td style="font-family:sans-serif;padding:8px;">
                    <a href="/conversations/${encodeURIComponent(c.id)}">View</a> | 
                    <button onclick="refreshConversation('${c.id}')" style="font-size:12px;padding:2px 6px;">Refresh</button>
                </td>
            </tr>
        `}).join('');

        const emergencyCount = convs.filter(c => c.immediateIntervention || c.tendency === 'severe').length;
        const highRiskCount = convs.filter(c => c.tendency === 'high').length;
        const missingTranscripts = convs.filter(c => !c.transcript || c.transcript.trim().length === 0).length;
        const withGeminiAnalysis = convs.filter(c => c.geminiAnalysis).length;
        const withRecordings = convs.filter(c => c.recordingUrl && c.recordingUrl.trim().length > 0).length;

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
                .no_transcript{background:#7c2d12}
                .stats{display:flex;gap:20px;margin:20px 0;flex-wrap:wrap;}
                .stat-card{background:#f8f9fa;padding:15px;border-radius:8px;text-align:center;min-width:120px;}
                .stat-number{font-size:24px;font-weight:bold;color:#333;}
                .stat-label{font-size:14px;color:#666;}
                .emergency{background:#fee2e2;border-left:4px solid #dc2626;}
                .actions{margin:20px 0;padding:15px;background:#f0f9ff;border-radius:8px;}
                .btn{padding:8px 16px;margin:5px;border:none;border-radius:4px;cursor:pointer;font-size:14px;}
                .btn-primary{background:#3b82f6;color:white;}
                .btn-secondary{background:#6b7280;color:white;}
                .loading{display:none;color:#3b82f6;}
                table{width:100%;margin-top:20px;}
                th{background:#f1f5f9;padding:8px;text-align:left;font-size:13px;}
                td{border-bottom:1px solid #e5e7eb;}
            </style>
        </head>
        <body style="margin:24px;font-family:sans-serif;">
            <h2>🧠 Mental Health Monitoring Dashboard</h2>
            <p><a href="/health">Health Check</a> | <a href="/api/conversations">API</a></p>
            
            <div class="actions">
                <button class="btn btn-primary" onclick="refreshAllConversations()">🔄 Refresh All Missing Transcripts</button>
                <button class="btn btn-primary" onclick="importFromUltravox()" style="background:#059669;">📥 Import from Ultravox</button>
                <button class="btn btn-secondary" onclick="cleanupInvalidCalls()" style="background:#dc2626;">🧹 Cleanup Invalid Calls</button>
                <button class="btn btn-secondary" onclick="location.reload()">🔃 Reload Dashboard</button>
                <span class="loading" id="loading">⏳ Processing...</span>
                <div id="result" style="margin-top:10px;"></div>
            </div>
            
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
                <div class="stat-card" style="background:#fee2e2;">
                    <div class="stat-number">${missingTranscripts}</div>
                    <div class="stat-label">📝 No Transcript</div>
                </div>
                <div class="stat-card" style="background:#dcfce7;">
                    <div class="stat-number">${withGeminiAnalysis}</div>
                    <div class="stat-label">🤖 AI Analyzed</div>
                </div>
                <div class="stat-card" style="background:#e0f2fe;">
                    <div class="stat-number">${withRecordings}</div>
                    <div class="stat-label">🎵 With Recording</div>
                </div>
            </div>
            
            <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:1400px;">
                <thead>
                    <tr>
                        <th style="padding:8px;text-align:left;">Call ID</th>
                        <th style="padding:8px;text-align:left;">Phone</th>
                        <th style="padding:8px;text-align:left;">Started</th>
                        <th style="padding:8px;text-align:left;">Updated</th>
                        <th style="padding:8px;text-align:left;">Status</th>
                        <th style="padding:8px;text-align:left;">Transcript</th>
                        <th style="padding:8px;text-align:left;">Recording</th>
                        <th style="padding:8px;text-align:left;">Risk Level</th>
                        <th style="padding:8px;text-align:left;">Counselling</th>
                        <th style="padding:8px;text-align:left;">Score</th>
                        <th style="padding:8px;text-align:left;">Alert</th>
                        <th style="padding:8px;text-align:left;">AI</th>
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
                <p><strong>🚨 Alert:</strong> Immediate intervention may be needed | <strong>🤖 AI:</strong> Gemini analysis available</p>
            </div>
            
            <script>
                async function refreshConversation(id) {
                    try {
                        document.getElementById('loading').style.display = 'inline';
                        const response = await fetch(\`/api/conversations/\${id}/refresh\`, { 
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const result = await response.json();
                        document.getElementById('loading').style.display = 'none';
                        
                        if (result.ok) {
                            document.getElementById('result').innerHTML = \`<div style="color:green;">✅ \${result.message}</div>\`;
                            setTimeout(() => location.reload(), 2000);
                        } else {
                            document.getElementById('result').innerHTML = \`<div style="color:red;">❌ \${result.error}</div>\`;
                        }
                    } catch (error) {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('result').innerHTML = \`<div style="color:red;">❌ Error: \${error.message}</div>\`;
                    }
                }
                
                async function refreshAllConversations() {
                    try {
                        document.getElementById('loading').style.display = 'inline';
                        const response = await fetch('/api/conversations/refresh-all', { 
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const result = await response.json();
                        document.getElementById('loading').style.display = 'none';
                        
                        if (result.ok) {
                            const updated = result.results.filter(r => r.status === 'updated').length;
                            const failed = result.results.filter(r => r.status === 'failed').length;
                            document.getElementById('result').innerHTML = \`<div style="color:green;">✅ Processed \${result.results.length} conversations: \${updated} updated, \${failed} failed</div>\`;
                            setTimeout(() => location.reload(), 3000);
                        } else {
                            document.getElementById('result').innerHTML = \`<div style="color:red;">❌ \${result.error}</div>\`;
                        }
                    } catch (error) {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('result').innerHTML = \`<div style="color:red;">❌ Error: \${error.message}</div>\`;
                    }
                }
                
                async function importFromUltravox() {
                    try {
                        document.getElementById('loading').style.display = 'inline';
                        const response = await fetch('/api/conversations/import-from-ultravox', { 
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ limit: 20 })
                        });
                        const result = await response.json();
                        document.getElementById('loading').style.display = 'none';
                        
                        if (result.ok) {
                            const created = result.summary.created;
                            const updated = result.summary.updated;
                            document.getElementById('result').innerHTML = \`<div style="color:green;">📥 Import complete: \${created} new calls, \${updated} updated calls</div>\`;
                            setTimeout(() => location.reload(), 3000);
                        } else {
                            document.getElementById('result').innerHTML = \`<div style="color:red;">❌ \${result.error}</div>\`;
                        }
                    } catch (error) {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('result').innerHTML = \`<div style="color:red;">❌ Error: \${error.message}</div>\`;
                    }
                }
                
                async function cleanupInvalidCalls() {
                    try {
                        document.getElementById('loading').style.display = 'inline';
                        const response = await fetch('/api/conversations/cleanup-invalid', { 
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const result = await response.json();
                        document.getElementById('loading').style.display = 'none';
                        
                        if (result.ok) {
                            const invalid = result.summary.invalid;
                            const valid = result.summary.valid;
                            document.getElementById('result').innerHTML = \`<div style="color:green;">🧹 Cleanup complete: \${valid} valid calls, \${invalid} invalid calls found</div>\`;
                            setTimeout(() => location.reload(), 2000);
                        } else {
                            document.getElementById('result').innerHTML = \`<div style="color:red;">❌ \${result.error}</div>\`;
                        }
                    } catch (error) {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('result').innerHTML = \`<div style="color:red;">❌ Error: \${error.message}</div>\`;
                    }
                }
            </script>
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

        const geminiSection = c.geminiAnalysis ? `
        <h3>🤖 AI Analysis (Gemini)</h3>
        <div style="background:#f0fdf4;padding:15px;border-radius:8px;margin:10px 0;">
            <p><strong>Risk Level:</strong> <span class="badge ${c.geminiAnalysis.risk_level}">${c.geminiAnalysis.risk_level}</span></p>
            <p><strong>Counseling Needed:</strong> <span class="badge ${c.geminiAnalysis.counseling_needed}">${c.geminiAnalysis.counseling_needed}</span></p>
            ${c.geminiAnalysis.emotional_state ? `<p><strong>Emotional State:</strong> ${c.geminiAnalysis.emotional_state}</p>` : ''}
            ${c.geminiAnalysis.language_used ? `<p><strong>Language Used:</strong> ${c.geminiAnalysis.language_used}</p>` : ''}
            ${c.geminiAnalysis.immediate_intervention ? `<p><strong>Immediate Intervention:</strong> <span style="color:red;font-weight:bold;">${c.geminiAnalysis.immediate_intervention}</span></p>` : ''}
            ${c.geminiAnalysis.assessment_summary ? `<p><strong>Assessment:</strong> ${c.geminiAnalysis.assessment_summary}</p>` : ''}
            ${c.geminiAnalysis.concerning_phrases && c.geminiAnalysis.concerning_phrases.length > 0 ? `
                <p><strong>Concerning Phrases:</strong> ${c.geminiAnalysis.concerning_phrases.map(p => `<span style="background:#fee2e2;padding:2px 6px;border-radius:4px;margin:2px;">${p}</span>`).join(' ')}</p>
            ` : ''}
            ${c.geminiAnalysis.support_recommendations ? `<p><strong>Support Recommendations:</strong> ${c.geminiAnalysis.support_recommendations}</p>` : ''}
            ${c.geminiAnalysis.confidence_level ? `<p><strong>Confidence Level:</strong> ${c.geminiAnalysis.confidence_level}</p>` : ''}
        </div>` : '<h3>🤖 AI Analysis</h3><p style="color:#6b7280;">No AI analysis available</p>';

        const detectedTermsSection = c.detectedTerms && c.detectedTerms.length > 0 ? `
        <h3>🔍 Detected Terms</h3>
        <div style="margin:10px 0;">
            ${c.detectedTerms.map(term => `
                <span style="background:#${term.category === 'severe' ? 'fee2e2' : term.category === 'high' ? 'fef3c7' : term.category === 'medium' ? 'ddd6fe' : 'e5e7eb'};padding:4px 8px;border-radius:6px;margin:3px;display:inline-block;font-size:12px;">
                    ${term.term} <em>(${term.category})</em>
                </span>
            `).join('')}
        </div>` : '';

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
            .btn{padding:8px 16px;margin:5px;border:none;border-radius:4px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block;}
            .btn-primary{background:#3b82f6;color:white;}
            .btn-secondary{background:#6b7280;color:white;}
        </style>
    </head>
    <body style="margin:24px;font-family:sans-serif;">
        <div style="margin-bottom:20px;">
            <a href="/dashboard">← Back to Dashboard</a>
            <div style="float:right;">
                <button class="btn btn-primary" onclick="refreshConversation()">🔄 Refresh Transcript</button>
                <button class="btn btn-secondary" onclick="regenerateAIAnalysis()">🤖 Regenerate AI Analysis</button>
            </div>
        </div>
        
        <h2>Conversation Details</h2>
        
        <div style="background:#f8f9fa;padding:20px;border-radius:8px;margin:20px 0;">
            <h3>📋 Basic Information</h3>
            <p><strong>Call ID:</strong> ${c.id}</p>
            <p><strong>From:</strong> ${c.from}</p>
            <p><strong>Created:</strong> ${new Date(c.createdAt).toLocaleString()}</p>
            <p><strong>Updated:</strong> ${new Date(c.updatedAt).toLocaleString()}</p>
            <p><strong>Status:</strong> <span class="badge ${c.status || 'unknown'}">${c.status || 'unknown'}</span></p>
            ${c.recordingUrl ? `<p><strong>Recording:</strong> <a href="${c.recordingUrl}" target="_blank" style="color:#059669;text-decoration:none;">🎵 Play Audio Recording</a></p>` : '<p><strong>Recording:</strong> <span style="color:#6b7280;">No recording available</span></p>'}
        </div>
        
        <div style="background:#f0f9ff;padding:20px;border-radius:8px;margin:20px 0;">
            <h3>🎯 Risk Assessment</h3>
            <p><strong>Risk Level:</strong> <span class="badge ${c.tendency}">${c.tendency}</span></p>
            <p><strong>Counselling Needed:</strong> <span class="badge ${c.needsCounselling}">${c.needsCounselling}</span></p>
            <p><strong>Risk Score:</strong> ${c.score || 0}</p>
            <p><strong>Immediate Intervention:</strong> ${c.immediateIntervention ? '🚨 <span style="color:red;font-weight:bold;">YES</span>' : 'No'}</p>
        </div>
        
        ${geminiSection}
        
        ${detectedTermsSection}
        
        <h3>📋 System Review</h3>
        <div style="background:#fffbeb;padding:15px;border-radius:8px;border-left:4px solid #f59e0b;">
            <p>${(c.summary || 'No system review available').replace(/</g, '&lt;')}</p>
        </div>
        
        <h3>📝 Transcript</h3>
        <div style="background:#f9fafb;padding:15px;border-radius:8px;border:1px solid #e5e7eb;">
            ${c.transcript && c.transcript.trim() ? 
                `<pre style="white-space:pre-wrap;margin:0;">${c.transcript.replace(/</g, '&lt;')}</pre>` :
                '<p style="color:#6b7280;font-style:italic;">No transcript available</p>'
            }
        </div>
        
        ${c.recordingUrl ? `
        <h3>🎵 Call Recording</h3>
        <div style="background:#f0f9ff;padding:20px;border-radius:8px;border:1px solid #dbeafe;margin:20px 0;">
            <div style="margin-bottom:10px;">
                <audio controls style="width:100%;max-width:500px;">
                    <source src="${c.recordingUrl}" type="audio/mpeg">
                    <source src="${c.recordingUrl}" type="audio/wav">
                    <source src="${c.recordingUrl}" type="audio/ogg">
                    Your browser does not support the audio element.
                </audio>
            </div>
            <p style="margin:5px 0;font-size:12px;color:#6b7280;">
                <strong>Direct link:</strong> <a href="${c.recordingUrl}" target="_blank" style="color:#059669;">${c.recordingUrl}</a>
            </p>
            <p style="margin:5px 0;font-size:12px;color:#6b7280;">
                💡 <em>Tip: Right-click the audio player and select "Download" to save the recording locally.</em>
            </p>
        </div>
        ` : ''}
        
        <h3>🔧 Raw Data</h3>
        <details style="margin:20px 0;">
            <summary style="cursor:pointer;padding:10px;background:#f3f4f6;border-radius:4px;">Show Raw Data</summary>
            <pre style="white-space:pre-wrap;font-size:12px;background:#f9fafb;padding:15px;border-radius:8px;margin-top:10px;overflow:auto;">${JSON.stringify(c.raw || {}, null, 2).replace(/</g, '&lt;')}</pre>
        </details>
        
        <div id="result" style="margin-top:20px;"></div>
        
        <script>
            async function refreshConversation() {
                try {
                    document.getElementById('result').innerHTML = '<div style="color:#3b82f6;">⏳ Refreshing transcript and analysis...</div>';
                    const response = await fetch(\`/api/conversations/${encodeURIComponent(c.id)}/refresh\`, { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    const result = await response.json();
                    
                    if (result.ok) {
                        document.getElementById('result').innerHTML = \`<div style="color:green;padding:10px;background:#f0fdf4;border-radius:4px;">✅ \${result.message}</div>\`;
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        document.getElementById('result').innerHTML = \`<div style="color:red;padding:10px;background:#fef2f2;border-radius:4px;">❌ \${result.error}</div>\`;
                    }
                } catch (error) {
                    document.getElementById('result').innerHTML = \`<div style="color:red;padding:10px;background:#fef2f2;border-radius:4px;">❌ Error: \${error.message}</div>\`;
                }
            }

            async function regenerateAIAnalysis() {
                try {
                    document.getElementById('result').innerHTML = '<div style="color:#3b82f6;">🤖 Regenerating AI analysis... This may take a moment.</div>';
                    const response = await fetch(\`/api/conversations/${encodeURIComponent(c.id)}/regenerate-analysis\`, { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    const result = await response.json();
                    
                    if (result.ok) {
                        document.getElementById('result').innerHTML = \`<div style="color:green;padding:10px;background:#f0fdf4;border-radius:4px;">✅ \${result.message}</div>\`;
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        document.getElementById('result').innerHTML = \`<div style="color:red;padding:10px;background:#fef2f2;border-radius:4px;">❌ \${result.error}</div>\`;
                    }
                } catch (error) {
                    document.getElementById('result').innerHTML = \`<div style="color:red;padding:10px;background:#fef2f2;border-radius:4px;">❌ Error: \${error.message}</div>\`;
                }
            }
        </script>
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