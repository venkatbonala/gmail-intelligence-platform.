import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '../.env', override: true });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  console.log('Listing models...');
  try {
    // In @google/generative-ai, we can list models using the REST API or using custom fetch since listModels is on the client
    // Let's call the listModels endpoint using axios directly since it's cleaner.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    console.log('Available models:');
    data.models?.forEach(m => console.log(`- ${m.name} (displayName: ${m.displayName})`));
  } catch (error) {
    console.error('Failed to list models:', error.message);
  }
}

listModels();
