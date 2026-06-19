import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '../.env', override: true });

async function testGemini() {
  console.log('Testing Gemini API key...');
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent('Say Hello in one word.');
    console.log('Gemini response:', result.response.text().trim());
  } catch (error) {
    console.error('Gemini API test failed:', error.message);
  }
}

testGemini();
