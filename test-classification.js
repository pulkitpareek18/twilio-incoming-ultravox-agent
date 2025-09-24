// Test file for enhanced mental health classification system
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

let gemini;
if (GEMINI_API_KEY) {
    gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log('Gemini AI initialized successfully');
}

// Enhanced Classification logic (copied from main app for testing)
async function classifyRiskAndCounselling(transcriptText) {
    const text = (transcriptText || '').toLowerCase();
    let score = 0;
    let detectedTerms = [];
    
    // Enhanced keyword categories with Hindi support
    const severeTerms = [
        // English terms
        'suicide', 'kill myself', 'end my life', 'i want to die', 'hang myself', 'jump off', 'overdose', 
        'self harm', 'self-harm', 'cut myself', 'no reason to live', 'better off dead', 'end it all',
        'take my own life', 'razor blade', 'poison myself', 'gun to my head', 'final goodbye',
        // Hindi terms (transliterated)
        'marna chahta hun', 'jaan dena', 'suicide karna', 'zindagi khatam', 'maut aa jaye'
    ];
    
    const highTerms = [
        // English terms
        'i am going to', 'i have a plan', 'i bought a rope', 'i bought pills', 'goodbye forever', 
        'can\'t go on', 'hopeless', 'life is meaningless', 'nothing matters', 'give up completely',
        'no way out', 'trapped forever', 'can\'t escape', 'ready to go', 'final decision',
        'wrote a note', 'said goodbye', 'planning to end', 'going to jump', 'bought the pills',
        // Hindi terms
        'koi raah nahi', 'umeed khatam', 'plan bana liya', 'alvida keh diya', 'bass khatam'
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

    // Count matches and calculate score with balanced logic
    severeTerms.forEach(term => {
        if (text.includes(term)) {
            score += 5;  // Increased severe term weight
            detectedTerms.push({ term, category: 'severe' });
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
        /i\s+(am|will|going to)\s+(kill|end|hurt|harm)/i,
        /tonight\s+(i|will|going)/i,
        /(plan|planning)\s+to\s+(die|kill|end)/i,
        /(ready|prepared)\s+to\s+(die|go|leave)/i
    ];
    
    immediateRiskPatterns.forEach(pattern => {
        if (pattern.test(text)) {
            score += 7;  // Very high score for immediate risk patterns
            detectedTerms.push({ term: 'immediate_risk_pattern', category: 'severe' });
        }
    });

    // Determine risk tendency based on adjusted score
    let tendency = 'no';
    if (score >= 12) tendency = 'severe';    // Very high threshold for severe (multiple severe terms or patterns)
    else if (score >= 8) tendency = 'high';  // Reduced from 5 to 8 for high risk
    else if (score >= 4) tendency = 'medium'; // Reduced from 3 to 4 for medium risk
    else if (score >= 1) tendency = 'low';   // Any detected term = low risk

    // Enhanced counselling recommendation
    let needsCounselling = 'no';
    if (tendency === 'severe' || tendency === 'high') needsCounselling = 'yes';
    else if (tendency === 'medium') needsCounselling = 'advised';

    // Enhanced review summary with action items
    const review = (() => {
        if (tendency === 'severe') return `🚨 SEVERE RISK DETECTED - Immediate intervention required. Score: ${score}. Terms: ${detectedTerms.map(t => t.term).join(', ')}. Consider emergency services.`;
        if (tendency === 'high') return `⚠️ HIGH RISK - Urgent counseling recommended. Score: ${score}. Monitor closely and provide immediate support resources.`;
        if (tendency === 'medium') return `⚡ MODERATE CONCERN - Professional counseling advised. Score: ${score}. Provide mental health resources and follow up.`;
        if (tendency === 'low') return `💭 MILD DISTRESS - Supportive listening recommended. Score: ${score}. Emotional support and coping strategies helpful.`;
        return 'No significant risk indicators detected. Maintain supportive, empathetic tone.';
    })();

    return { 
        tendency, 
        needsCounselling, 
        review, 
        score, 
        detectedTerms,
        immediateIntervention: tendency === 'severe'
    };
}

// Test cases to validate the enhanced classification system
const testCases = [
    {
        name: "Severe Risk - Direct Suicidal Statement (English)",
        transcript: "I want to kill myself. I can't take it anymore. I have no reason to live.",
        expectedTendency: "severe",
        expectedCounselling: "yes"
    },
    {
        name: "Severe Risk - Specific Plan",
        transcript: "I bought a rope yesterday. I am going to end it tonight. Goodbye forever.",
        expectedTendency: "severe",
        expectedCounselling: "yes"
    },
    {
        name: "High Risk - Hopelessness",
        transcript: "Life is meaningless. I can't go on like this. Nothing matters anymore.",
        expectedTendency: "high",
        expectedCounselling: "yes"
    },
    {
        name: "Medium Risk - Depression Symptoms",
        transcript: "I'm feeling very depressed lately. I can't sleep and have lost interest in everything.",
        expectedTendency: "medium",
        expectedCounselling: "advised"
    },
    {
        name: "Low Risk - General Stress",
        transcript: "I'm really stressed about work. I feel overwhelmed and frustrated.",
        expectedTendency: "low",
        expectedCounselling: "no"
    },
    {
        name: "Hindi Test - Severe Risk",
        transcript: "Main marna chahta hun. Zindagi khatam karna chahta hun. Koi raah nahi hai.",
        expectedTendency: "severe",
        expectedCounselling: "yes"
    },
    {
        name: "Hindi Test - Medium Risk",
        transcript: "Main bahut pareshan hun. Depression hai mujhe. Ro raha hun roz.",
        expectedTendency: "medium", 
        expectedCounselling: "advised"
    },
    {
        name: "Hindi Test - Low Risk",
        transcript: "Thoda tension hai office ka. Gussa aa raha hai. Dimag kharab hai.",
        expectedTendency: "low",
        expectedCounselling: "no"
    },
    {
        name: "Mixed Language Test",
        transcript: "I'm feeling hopeless. Zindagi mein koi meaning nahi hai. Can't go on.",
        expectedTendency: "high",
        expectedCounselling: "yes"
    },
    {
        name: "No Risk - Positive Conversation",
        transcript: "Thank you for listening. I feel better now after talking to you.",
        expectedTendency: "no",
        expectedCounselling: "no"
    }
];

async function runTests() {
    console.log("🧪 Running Enhanced Mental Health Classification Tests\n");
    console.log("=" * 70);
    
    let passed = 0;
    let failed = 0;
    
    for (const testCase of testCases) {
        console.log(`\nTest: ${testCase.name}`);
        console.log(`Input: "${testCase.transcript}"`);
        
        try {
            const result = await classifyRiskAndCounselling(testCase.transcript);
            
            console.log(`Results:`);
            console.log(`  Tendency: ${result.tendency} (expected: ${testCase.expectedTendency})`);
            console.log(`  Counselling: ${result.needsCounselling} (expected: ${testCase.expectedCounselling})`);
            console.log(`  Score: ${result.score}`);
            console.log(`  Detected Terms: ${result.detectedTerms.map(t => t.term).join(', ')}`);
            console.log(`  Immediate Intervention: ${result.immediateIntervention}`);
            
            const tendencyMatch = result.tendency === testCase.expectedTendency;
            const counsellingMatch = result.needsCounselling === testCase.expectedCounselling;
            
            if (tendencyMatch && counsellingMatch) {
                console.log(`✅ PASS`);
                passed++;
            } else {
                console.log(`❌ FAIL`);
                if (!tendencyMatch) console.log(`   - Tendency mismatch: got ${result.tendency}, expected ${testCase.expectedTendency}`);
                if (!counsellingMatch) console.log(`   - Counselling mismatch: got ${result.needsCounselling}, expected ${testCase.expectedCounselling}`);
                failed++;
            }
            
        } catch (error) {
            console.log(`❌ ERROR: ${error.message}`);
            failed++;
        }
        
        console.log("-".repeat(50));
    }
    
    console.log(`\n📊 Test Summary:`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    
    if (failed === 0) {
        console.log(`\n🎉 All tests passed! The enhanced classification system is working correctly.`);
    } else {
        console.log(`\n⚠️  Some tests failed. Please review the classification logic.`);
    }
}

// Run the tests
runTests().catch(error => {
    console.error("Test execution failed:", error);
    process.exit(1);
});