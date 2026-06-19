import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '../.env', override: true });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const schema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: [
        'Newsletters',
        'Job / Recruitment',
        'Finance',
        'Notifications',
        'Work / Professional',
        'Personal'
      ],
      description: 'The classified category'
    },
    summary: {
      type: 'string',
      description: 'A concise 1-2 sentence summary'
    }
  },
  required: ['category', 'summary']
};

async function testSchema() {
  console.log('Testing Gemini with gemini-2.5-flash-lite and responseSchema...');
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    
    const prompt = `
      You are an email intelligence assistant. Analyze the following email and perform two tasks:
      1. Classify it into exactly one of the enums defined in the JSON schema.
      2. Write a concise 1-2 sentence summary of the email focusing on the key message, action item, or intent.

      Sender: Devpost <support@devpost.com>
      Subject: Opening Ceremony Recording - USAII® Global AI Hackathon 2026
      Snippet: Dear Participants, Thank you for joining the USAII® Global AI Hackathon 2026 Opening Ceremony.
      Body: Dear Participants, Thank you for joining the USAII® Global AI Hackathon 2026 Opening Ceremony. The recording is now available on YouTube: https://youtu.be/cYA5GDck6zk. We encourage all participants to watch it.
    `;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    console.log('Gemini response:', result.response.text().trim());
  } catch (error) {
    console.error('Gemini call failed:', error);
  }
}

testSchema();
