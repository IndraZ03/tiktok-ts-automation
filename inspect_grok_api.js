import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
async function main() {
    const statePath = path.join(process.cwd(), 'grok-states', 'grok-state-indra.json');
    console.log('Loading state:', statePath);
    if (!fs.existsSync(statePath)) {
        console.error('File state tidak ditemukan:', statePath);
        process.exit(1);
    }
    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        ignoreDefaultArgs: ['--enable-automation'],
    });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        storageState: statePath,
    });
    const capturedRequests = [];
    const page = await context.newPage();
    page.on('request', async (req) => {
        const url = req.url();
        const method = req.method();
        if (url.includes('grok.com') || url.includes('x.ai')) {
            if (method === 'POST' || method === 'PUT' || url.includes('/api/') || url.includes('/rpc')) {
                const postData = req.postData();
                const headers = req.headers();
                console.log(`\n📥 [REQUEST] ${method} ${url}`);
                if (postData) {
                    console.log(`[PAYLOAD]`, postData.substring(0, 1500));
                }
                let parsedPayload = postData;
                try {
                    if (postData && postData.trim().startsWith('{'))
                        parsedPayload = JSON.parse(postData);
                }
                catch { }
                capturedRequests.push({
                    url,
                    method,
                    headers,
                    postData: parsedPayload,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
    page.on('response', async (res) => {
        const url = res.url();
        if ((url.includes('grok.com') || url.includes('x.ai')) && (url.includes('/api/') || res.request().method() === 'POST')) {
            console.log(`\n📤 [RESPONSE] ${res.status()} ${url}`);
            try {
                const text = await res.text();
                console.log(`[BODY]`, text.substring(0, 500));
                const matched = capturedRequests.slice().reverse().find(r => r.url === url);
                if (matched) {
                    try {
                        matched.responseBody = JSON.parse(text);
                    }
                    catch {
                        matched.responseBody = text.substring(0, 2000);
                    }
                }
            }
            catch { }
        }
    });
    console.log('🌐 Navigasi ke https://grok.com/imagine ...');
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
    // Auto type a sample prompt & generate if text box is available
    await page.waitForTimeout(3000);
    try {
        const promptInput = page.locator('textarea, div[contenteditable="true"], input[type="text"]').first();
        if (await promptInput.isVisible().catch(() => false)) {
            console.log('✍️ Mengetik prompt sampel untuk menangkap API request...');
            await promptInput.fill('A cinematic futuristic neon city');
            await page.waitForTimeout(1000);
            const submitBtn = page.locator('button[type="submit"], button[aria-label*="Submit"], button[aria-label*="Send"], button svg').first();
            if (await submitBtn.isVisible().catch(() => false)) {
                await submitBtn.click().catch(() => { });
                console.log('🚀 Tombol generate diklik');
            }
            else {
                await promptInput.press('Enter').catch(() => { });
            }
        }
    }
    catch (e) {
        console.log('ℹ Auto-prompt info:', e.message);
    }
    console.log('⏳ Menunggu 40 detik untuk menangkap seluruh lalu lintas API...');
    await page.waitForTimeout(40000);
    fs.writeFileSync(path.join(process.cwd(), 'grok_api_captured.json'), JSON.stringify(capturedRequests, null, 2));
    console.log('✅ Selesai! Seluruh API request berhasil disimpan di grok_api_captured.json');
    await browser.close();
}
main().catch(console.error);
