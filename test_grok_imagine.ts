import { generateGrokVideoBrowser } from './grok_browser_client.js';
import path from 'path';

async function main() {
  const args = process.argv.slice(2);
  let promptText = 'A cinematic futuristic smartphone commercial with sleek metallic finish and neon reflections';
  let stateName = 'inovasi2';
  let resolution = '720p';
  let duration = '10s';
  let aspectRatio = '9:16';
  let headless = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) promptText = args[++i];
    else if (args[i] === '--state' && args[i + 1]) stateName = args[++i];
    else if (args[i] === '--resolution' && args[i + 1]) resolution = args[++i];
    else if (args[i] === '--duration' && args[i + 1]) duration = args[++i];
    else if (args[i] === '--aspect-ratio' && args[i + 1]) aspectRatio = args[++i];
    else if (args[i] === '--headless') headless = true;
  }

  console.log('=== Testing Grok Imagine Playwright Automation ===');
  console.log(`State Name: ${stateName}`);
  console.log(`Prompt: "${promptText}"`);
  console.log(`Resolution: ${resolution}`);
  console.log(`Duration: ${duration}`);
  console.log(`Aspect Ratio: ${aspectRatio}`);
  console.log(`Headless: ${headless}`);

  const result = await generateGrokVideoBrowser({
    stateName,
    promptText,
    resolution,
    duration,
    aspectRatio,
    headless
  }, (msg, progress) => {
    console.log(`[PROGRESS] ${msg}${typeof progress === 'number' ? ` (${progress}%)` : ''}`);
  });

  console.log('\n✅ Success!');
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('\n❌ Execution Failed:', err);
  process.exit(1);
});
