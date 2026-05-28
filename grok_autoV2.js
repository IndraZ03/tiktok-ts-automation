// ═══════════════════════════════════════════════════════════════
//  GROK AUTO V2 — Injected by Selenium to automate grok.com
//  Combines grok_auto.js infrastructure + grok.js automation logic
//  Key difference: Uses "@" image referencing in prompts (frame-to-video)
//  and supports upscale/HD download workflow
// ═══════════════════════════════════════════════════════════════

(function() {
    'use strict';

    // ── Prevent double-injection ──
    if (window.__GROK_AUTO_V2_INJECTED) return;
    window.__GROK_AUTO_V2_INJECTED = true;

    // ── State shared with Selenium ──
    window.__GROK_AUTO = {
        status: 'idle',        // idle | running | done | error | cancelled | rate_limited
        progress: 0,           // 0-100
        message: '',           // Human-readable status
        videoUrl: null,        // Extracted video URL after generation
        error: null,           // Error message if any
        downloadReady: false,  // True when video is ready to download
        totalGenerated: 0,     // Running total of generated videos
        availableAt: null,     // Available again at time for rate limit reset
    };

    const STATE = window.__GROK_AUTO;

    // ── Helpers ──
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function log(msg) {
        STATE.message = msg;
        console.log(`[GrokAutoV2] ${msg}`);
    }

    function $(selector) {
        return document.querySelector(selector);
    }

    function $$(selector) {
        return document.querySelectorAll(selector);
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    async function waitForElement(selector, timeout = 15000, mustBeVisible = true) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const elements = $$(selector);
            for (const el of elements) {
                if (el && (!mustBeVisible || isVisible(el))) return el;
            }
            await sleep(200);
        }
        return null;
    }

    async function waitForAnyElement(selectors, timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const sel of selectors) {
                const el = $(sel);
                if (el && isVisible(el)) return el;
            }
            await sleep(200);
        }
        return null;
    }

    // Simulasi klik native kompleks (mengakali bot-detection React)
    function simulateClick(el) {
        if (!el) return false;
        const events = ['pointerover', 'mouseover', 'pointerdown', 'mousedown',
                        'pointerup', 'mouseup', 'click'];
        for (const evName of events) {
            const Ctor = evName.startsWith('pointer') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(evName, {
                bubbles: true, cancelable: true, composed: true,
                view: window, detail: 1
            }));
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //  NAVIGATE TO /imagine
    // ═══════════════════════════════════════════════════════════════
    async function ensureImaginePage() {
        if (location.pathname.includes('/imagine') && !location.pathname.includes('/imagine/')) {
            log('✅ Already on /imagine');
            return true;
        }
        log('🌐 Navigating to /imagine...');
        const imagineLink = await waitForElement('a[href="/imagine"]', 5000);
        if (imagineLink) {
            simulateClick(imagineLink);
            await sleep(2000);
            if (location.pathname.includes('/imagine')) {
                log('✅ Navigated to /imagine via link');
                return true;
            }
        }
        location.href = 'https://grok.com/imagine';
        await sleep(3000);
        return location.pathname.includes('/imagine');
    }

    // ═══════════════════════════════════════════════════════════════
    //  UPLOAD IMAGE (Frame) — from grok.js logic
    //  Finds attach button, clicks it, then injects file to input
    // ═══════════════════════════════════════════════════════════════
    async function uploadImage(imageBase64, imageName) {
        log('📷 Uploading image (frame)...');

        // Decode base64 to blob
        let b64 = imageBase64;
        if (b64.includes(',')) b64 = b64.split(',')[1];
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const file = new File([blob], imageName || `image-${Date.now()}.jpg`, { type: 'image/jpeg' });

        // (a) Coba klik tombol attach/upload dulu (grok.js approach)
        const uploadBtn = await waitForElement(
            'button[aria-label*="file"], button[aria-label*="Attach"], button[aria-label*="Lampirkan"]',
            5000, true
        );
        if (uploadBtn) {
            simulateClick(uploadBtn);
            await sleep(800);
            log('📎 Attach button clicked');
        }

        // (b) Inject file ke DOM input[type=file]
        const fileInput = await waitForElement('input[type="file"]', 10000, false);
        if (!fileInput) {
            log('⚠️ File input not found');
            return false;
        }

        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        log(`📤 Image injected (${file.size} bytes)`);
        await sleep(3000);

        // Wait for upload indicator to disappear
        const start = Date.now();
        while (Date.now() - start < 30000) {
            const uploading = $('div[class*="uploading"], .animate-spin');
            if (!uploading || !isVisible(uploading)) break;
            await sleep(500);
        }

        log('✅ Image uploaded');
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //  SELECT VIDEO SETTINGS
    //  Configurable: mode, resolution, duration, aspect ratio
    //  Uses case-insensitive aria-label matching for robustness
    // ═══════════════════════════════════════════════════════════════

    // Helper: find radiogroup by aria-label (CASE-INSENSITIVE)
    function _findRadioGroup(labelText) {
        const labelLower = labelText.toLowerCase();
        const groups = document.querySelectorAll('div[role="radiogroup"]');
        for (const g of groups) {
            const aria = (g.getAttribute('aria-label') || '').toLowerCase();
            if (aria === labelLower || aria.includes(labelLower)) return g;
        }
        return null;
    }

    async function clickRadioOption(groupAriaLabel, optionText, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // Case-insensitive search for radio group
                const group = _findRadioGroup(groupAriaLabel);
                if (!group) {
                    log(`⚠️ Radio group "${groupAriaLabel}" not found (attempt ${attempt})`);
                    await sleep(800);
                    continue;
                }
                const buttons = group.querySelectorAll('button[role="radio"]');
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    if (txt === optionText || txt.includes(optionText)) {
                        const alreadyChecked = btn.getAttribute('aria-checked') === 'true';
                        if (alreadyChecked) {
                            log(`✅ "${optionText}" already selected`);
                            return true;
                        }
                        simulateClick(btn);
                        await sleep(400);
                        if (btn.getAttribute('aria-checked') === 'true') {
                            log(`✅ "${optionText}" selected`);
                            return true;
                        }
                        log(`⚠️ Click sent but aria-checked not true yet, retrying...`);
                    }
                }
                log(`⚠️ Option "${optionText}" not found in group "${groupAriaLabel}" (attempt ${attempt})`);
            } catch(e) {
                log(`⚠️ clickRadioOption error: ${e.message}`);
            }
            await sleep(600);
        }
        return false;
    }

    async function selectAspectRatio(ratio = '9:16', retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // Case-insensitive: find button with aria-label containing "aspect" or "rasio"
                let ratioBtn = null;
                for (const btn of document.querySelectorAll('button[aria-label]')) {
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (aria.includes('aspect') || aria.includes('rasio')) {
                        ratioBtn = btn;
                        break;
                    }
                }
                if (!ratioBtn) {
                    log(`⚠️ Aspect ratio button not found (attempt ${attempt})`);
                    await sleep(800);
                    continue;
                }

                const currentText = (ratioBtn.textContent || '').trim();
                if (currentText.includes(ratio)) {
                    log(`✅ Aspect ratio ${ratio} already selected`);
                    return true;
                }

                simulateClick(ratioBtn);
                await sleep(700);

                const menuItems = [
                    ...$$('div[role="menuitem"]'),
                    ...$$('button[role="menuitem"]'),
                    ...$$('div[data-radix-collection-item]'),
                ];

                let clicked = false;
                for (const item of menuItems) {
                    const txt = (item.textContent || '').trim();
                    if (txt === ratio || txt.includes(ratio)) {
                        simulateClick(item);
                        await sleep(500);
                        clicked = true;
                        log(`✅ Aspect ratio ${ratio} selected`);
                        break;
                    }
                }

                if (!clicked) {
                    for (const el of $$('*')) {
                        if (el.children.length === 0) {
                            const t = (el.textContent || '').trim();
                            if (t === ratio) {
                                simulateClick(el.closest('[role="menuitem"]') || el);
                                await sleep(500);
                                clicked = true;
                                log(`✅ Aspect ratio ${ratio} selected (fallback)`);
                                break;
                            }
                        }
                    }
                }

                if (!clicked) {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    await sleep(300);
                    log(`⚠️ Ratio ${ratio} option not found in dropdown (attempt ${attempt})`);
                    continue;
                }

                return true;

            } catch(e) {
                log(`⚠️ selectAspectRatio error: ${e.message}`);
            }
            await sleep(600);
        }
        return false;
    }

    // settings = { genMode, resolution, duration, aspectRatio }
    async function selectVideoSettings(settings = {}) {
        const genMode     = settings.genMode     || 'Video';
        const resolution  = settings.resolution  || '720p';
        const duration    = settings.duration    || '10s';
        const aspectRatio = settings.aspectRatio || '9:16';

        log(`⚙️ Configuring video settings: ${genMode} | ${resolution} | ${duration} | ${aspectRatio}...`);

        const barReady = await waitForElement('div[role="radiogroup"]', 8000);
        if (!barReady) {
            log('⚠️ Radio controls not found in page, skipping settings');
            return false;
        }
        await sleep(500);

        let allOk = true;

        // 1. Mode (search multiple possible aria-labels, case-insensitive)
        const modeLabels = ['generation mode', 'mode generasi'];
        let modeOk = false;
        for (const lbl of modeLabels) {
            modeOk = await clickRadioOption(lbl, genMode);
            if (modeOk) break;
        }
        if (!modeOk) {
            log(`⚠️ Could not select ${genMode} mode via label, trying fallback...`);
            for (const rg of $$('div[role="radiogroup"]')) {
                for (const btn of rg.querySelectorAll('button[role="radio"]')) {
                    if ((btn.textContent || '').trim() === genMode) {
                        simulateClick(btn);
                        await sleep(400);
                        log(`✅ ${genMode} mode selected (fallback)`);
                        modeOk = true;
                        break;
                    }
                }
                if (modeOk) break;
            }
        }
        await sleep(300);

        // 2. Resolution
        const resLabels = ['video resolution', 'resolusi video'];
        let resOk = false;
        for (const lbl of resLabels) {
            resOk = await clickRadioOption(lbl, resolution);
            if (resOk) break;
        }
        if (!resOk) allOk = false;
        await sleep(300);

        // 3. Duration
        const durLabels = ['video duration', 'durasi video'];
        let durOk = false;
        for (const lbl of durLabels) {
            durOk = await clickRadioOption(lbl, duration);
            if (durOk) break;
        }
        if (!durOk) allOk = false;
        await sleep(300);

        // 4. Aspect Ratio
        const ratioOk = await selectAspectRatio(aspectRatio);
        if (!ratioOk) allOk = false;
        await sleep(300);

        if (allOk) {
            log(`✅ All settings OK: ${genMode} | ${resolution} | ${duration} | ${aspectRatio}`);
        } else {
            log('⚠️ Some settings may not have been set correctly, continuing anyway...');
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //  FILL PROMPT WITH "@" IMAGE REFERENCE — from grok.js logic
    //  Flow: type "use @" → select dropdown → type rest of prompt
    //  This attaches the uploaded image as a start frame reference
    // ═══════════════════════════════════════════════════════════════
    async function fillPromptWithImageRef(promptText, hasImage = false) {
        log('📝 Filling prompt with @ image reference...');

        // Find the content-editable prompt editor (TipTap/ProseMirror)
        let editor = $('div.tiptap.ProseMirror[contenteditable="true"]');
        if (!editor) {
            editor = $('[contenteditable="true"]');
        }
        const textarea = $('textarea');

        const target = editor || textarea;
        if (!target) {
            log('❌ Could not find prompt editor');
            return false;
        }

        target.scrollIntoView({ block: 'center' });
        target.focus();
        await sleep(300);

        // Clear existing content
        if (target.tagName.toLowerCase() === 'textarea') {
            target.value = '';
            target.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand('selectAll', false);
            document.execCommand('delete', false);
            await sleep(200);
        }

        if (hasImage) {
            // ── GROK.JS FLOW: "@" image referencing ──
            // Step 1: Type "use @" to trigger asset dropdown
            log('⌨️ Typing "@" to attach start frame...');
            document.execCommand('insertText', false, 'use ');
            document.execCommand('insertText', false, '@');
            await sleep(1500); // Wait for Grok dropdown to appear

            // Step 2: Select first item from dropdown (ArrowDown + Enter)
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keyup',   { key: 'ArrowDown', keyCode: 40, bubbles: true }));
            await sleep(300);
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
            await sleep(500);

            // Step 3: Complete the reference phrase
            document.execCommand('insertText', false, ' as the exact start frame. ');
            await sleep(300);

            // Step 4: Append the actual prompt text
            log('📝 Completing prompt text...');
            document.execCommand('insertText', false, promptText);
        } else {
            // No image — just type the prompt directly
            document.execCommand('insertText', false, promptText);
        }

        // Dispatch events to ensure React picks up the change
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);

        // Verify prompt was filled
        const actualText = (target.textContent || target.value || '').trim();
        if (actualText) {
            log(`✅ Prompt filled: ${actualText.substring(0, 80)}...`);
            return true;
        }

        // Fallback: innerHTML method (editor only)
        if (editor) {
            log('🔄 Trying innerHTML fallback...');
            const fullPrompt = hasImage
                ? `use @image as the exact start frame. ${promptText}`
                : promptText;
            editor.innerHTML = '<p>' + fullPrompt + '</p>';
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            await sleep(500);

            if (editor.textContent.trim()) {
                log(`✅ Prompt filled (innerHTML): ${editor.textContent.substring(0, 80)}...`);
                return true;
            }
        }

        log('❌ Could not fill prompt');
        return false;
    }

    // Backward-compat: simple prompt fill without @ reference
    async function fillPrompt(promptText) {
        return fillPromptWithImageRef(promptText, false);
    }

    // ═══════════════════════════════════════════════════════════════
    //  CLICK GENERATE / SUBMIT — from grok_auto.js + grok.js
    //  Tries: aria-label → SVG icon → Ctrl+Enter → fallback button
    // ═══════════════════════════════════════════════════════════════
    async function clickGenerate() {
        log('🚀 Clicking Generate...');

        // 1. Try known aria-labels
        const labels = ['buat video', 'create video', 'generate', 'submit', 'buat gambar', 'create image', 'send'];
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
            if (!isVisible(btn)) continue;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (labels.some(l => aria.includes(l))) {
                simulateClick(btn);
                try { btn.click(); } catch(e){}
                log(`✅ Generate clicked (aria-label: ${aria})`);
                await sleep(2000);
                return true;
            }
        }

        // 2. Try "Generate video" text button (grok.js detection)
        for (const btn of allBtns) {
            if (!isVisible(btn)) continue;
            const text = (btn.innerText || btn.textContent || '').trim();
            if (text.includes('Generate video') || text.includes('Generate image') ||
                text.includes('Buat video') || text.includes('Buat gambar')) {
                simulateClick(btn);
                try { btn.click(); } catch(e){}
                log(`✅ Generate clicked (text: "${text}")`);
                await sleep(2000);
                return true;
            }
        }

        // 3. Try SVG icon match (send/arrow)
        for (const btn of allBtns) {
            if (!isVisible(btn)) continue;
            const paths = btn.querySelectorAll('svg path');
            if (paths.length > 0) {
                const d = Array.from(paths).map(p => p.getAttribute('d') || '').join(' ');
                if (d.includes('M3') && d.includes('21l19-9') ||
                    d.includes('4 12l1.41 1.41L11') ||
                    d.includes('M12 4l-8 8h6v8h4v-8h6z') ||
                    d.includes('15 21v-8a1 1')) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.bottom > window.innerHeight / 2) {
                        simulateClick(btn);
                        try { btn.click(); } catch(e){}
                        log(`✅ Generate clicked (SVG icon match)`);
                        await sleep(2000);
                        return true;
                    }
                }
            }
        }

        // 4. Fallback: Ctrl+Enter / Enter on editor (grok.js approach)
        const editor = $('div.tiptap.ProseMirror[contenteditable="true"]') || $('[contenteditable="true"]');
        if (editor) {
            editor.focus();
            
            const eventCtrl = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13,
                ctrlKey: true, metaKey: true, bubbles: true, cancelable: true
            });
            editor.dispatchEvent(eventCtrl);
            await sleep(500);
            
            const eventEnter = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13,
                bubbles: true, cancelable: true
            });
            editor.dispatchEvent(eventEnter);
            
            log('✅ Generate triggered via Enter keys on editor');
            await sleep(2000);
            
            if (document.querySelector('span.animate-pulse')) {
                return true;
            }
        }

        // 5. Last resort: round button
        const roundBtn = $('button.group[type="button"]') || $('button.rounded-full[type="button"]');
        if (roundBtn && isVisible(roundBtn)) {
            simulateClick(roundBtn);
            try { roundBtn.click(); } catch(e){}
            log('✅ Generate clicked (fallback round button)');
            await sleep(2000);
            return true;
        }

        log('❌ Could not find Generate button');
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESS DETECTION — 
    // ═══════════════════════════════════════════════════════════════

    function _isGeneratingOverlayVisible() {
        const pulseSpans = $$('span.animate-pulse');
        for (const s of pulseSpans) {
            const t = s.textContent.trim();
            if (t === 'Generating' || t === 'Membuat' || t === 'Menghasilkan') return true;
        }
        for (const btn of $$('button')) {
            const t = btn.textContent.trim();
            if (t === 'Membatalkan' || t === 'Cancel' || t === 'Cancelling') {
                if (isVisible(btn)) return true;
            }
        }
        for (const s of pulseSpans) {
            const t = s.textContent.trim();
            if (t.match(/^\d+%$/)) return true;
        }
        return false;
    }

    function _readGeneratingPercent() {
        for (const s of $$('span.tabular-nums')) {
            const t = s.textContent.trim();
            if (t.includes('%') && s.classList.contains('animate-pulse')) {
                const m = t.match(/(\d+)/);
                if (m) return parseInt(m[1]);
            }
        }
        for (const s of $$('span.tabular-nums')) {
            const t = s.textContent.trim();
            if (t.includes('%')) {
                const m = t.match(/(\d+)/);
                if (m) return parseInt(m[1]);
            }
        }
        return 0;
    }

    function _getFinishedVideoUrl() {
        const allVideos = Array.from(document.querySelectorAll('video'));
        if (allVideos.length === 0) return null;
        
        for (let i = allVideos.length - 1; i >= 0; i--) {
            const v = allVideos[i];
            if (v.src && v.src.includes('assets.grok.com') && v.src.includes('.mp4')) {
                const style = v.getAttribute('style') || '';
                if (isVisible(v) && (!style.includes('visibility: hidden'))) {
                    return v.src;
                }
            }
            // Fallback: check <source> child (grok.js approach)
            const source = v.querySelector('source');
            if (source && source.src && source.src.includes('.mp4')) {
                return source.src;
            }
        }
        return null;
    }

    function _isRateLimitReached() {
        let reached = false;
        const toasts = document.querySelectorAll('li[data-sonner-toast][data-type="error"]');
        for (const toast of toasts) {
            const text = (toast.textContent || '').toLowerCase();
            if (text.includes('rate limit') || text.includes('supergrok') ||
                text.includes('batas permintaan') || text.includes('batas request')) {
                reached = true;
                break;
            }
        }
        if (!reached) {
            const spans = document.querySelectorAll('span.font-medium, span.font-bold, span.font-semibold');
            for (const s of spans) {
                const t = (s.textContent || '').toLowerCase();
                if ((t.includes('rate limit') && t.includes('reached')) ||
                    (t.includes('upgrade') && t.includes('supergrok')) ||
                    (t.includes('batas permintaan') && t.includes('tercapai')) ||
                    (t.includes('batas request') && t.includes('tercapai'))) {
                    if (isVisible(s) || (s.closest('li[data-sonner-toast]'))) {
                        reached = true;
                        break;
                    }
                }
            }
        }
        if (reached) {
            // Deteksi "Available again at XX.XX" (English) or "Tersedia kembali pada XX.XX" (Indonesian)
            const allElements = document.querySelectorAll('li[data-sonner-toast] *, span, div');
            for (const el of allElements) {
                const txt = (el.textContent || '');
                // English: "Available again at 10:29" / "available again at 10.29 AM"
                const mEn = txt.match(/available again at\s+([0-9]{1,2}(?:[:.][0-9]{2})?(?:\s*(?:AM|PM|am|pm))?)/i);
                if (mEn) {
                    STATE.availableAt = mEn[1].trim();
                    break;
                }
                // Indonesian: "Tersedia kembali pada 10.29" / "Tersedia kembali pada 10:29"
                const mId = txt.match(/tersedia kembali\s+(?:pada|pukul)?\s*([0-9]{1,2}(?:[:.][0-9]{2})?(?:\s*(?:AM|PM|am|pm|WIB|WITA|WIT))?)/i);
                if (mId) {
                    STATE.availableAt = mId[1].trim();
                    break;
                }
            }
        }
        return reached;
    }

    function _isDownloadButtonVisible() {
        return _findDownloadButton() !== null;
    }

    function _findDownloadButton() {
        const articleBtns = Array.from(document.querySelectorAll(
            'main article button, [role="article"] button'
        )).filter(b => isVisible(b));

        for (let i = articleBtns.length - 1; i >= 0; i--) {
            const btn = articleBtns[i];
            
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (aria === 'unduh' || aria === 'download') {
                return btn;
            }

            const svgPaths = btn.querySelectorAll('svg path');
            if (svgPaths.length > 0) {
                const pathData = Array.from(svgPaths).map(p => p.getAttribute('d') || '').join(' ');
                if (pathData.includes('21 15') && pathData.includes('v4') && pathData.includes('M7 10')) {
                    return btn;
                }
                if (pathData.includes('M12') && pathData.includes('l5 5') && pathData.includes('v4')) {
                    return btn;
                }
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  WAIT FOR "Generate video" CONFIRMATION BUTTON — from grok.js
    //  Grok sometimes shows a confirmation "Generate video" button
    //  after prompt submission before actual generation starts
    // ═══════════════════════════════════════════════════════════════
    async function checkAndClickGenerateConfirmation() {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const confirmBtn = allBtns.find(b => {
            const text = (b.innerText || b.textContent || '').trim();
            return (text.includes('Generate video') || text.includes('Buat video')) && isVisible(b);
        });
        if (confirmBtn) {
            log('🔄 Confirmation "Generate video" button found, clicking...');
            simulateClick(confirmBtn);
            await sleep(1500);
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  UPSCALE / HD — from grok.js logic
    //  Opens "More" menu → clicks Upscale if available
    // ═══════════════════════════════════════════════════════════════
    async function attemptUpscale() {
        log('🔍 Attempting HD upscale...');

        // Check if HD button already exists
        const hdButton = $('button[aria-label*="HD"]');
        if (hdButton && isVisible(hdButton)) {
            simulateClick(hdButton);
            log('✅ HD button clicked directly');
            await sleep(15000); // Wait for upscale
            return true;
        }

        // Open "More options" menu (ellipsis ...)
        const moreBtn = $('button[aria-label*="More"], button[aria-label*="Lainnya"]');
        if (moreBtn && isVisible(moreBtn)) {
            simulateClick(moreBtn);
            await sleep(800);

            // Find Upscale menu item
            const menuItems = Array.from($$('div[role="menuitem"], button[role="menuitem"]'));
            const upscaleItem = menuItems.find(el =>
                (el.textContent || '').toLowerCase().includes('upscale') ||
                (el.textContent || '').toLowerCase().includes('hd')
            );

            if (upscaleItem) {
                simulateClick(upscaleItem);
                log('⏳ Upscale requested, waiting ~15s...');
                await sleep(15000);
                return true;
            } else {
                // Close menu
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(300);
                log('⚠️ Upscale option not found in menu');
            }
        } else {
            log('⚠️ More options button not found');
        }

        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  TRACK PROGRESS — from grok_auto.js (with grok.js additions)
    //  Watches generating overlay, handles Skip/Prefer, confirms done
    // ═══════════════════════════════════════════════════════════════
    async function trackProgress(timeoutMs = 600000) {
        log('⏳ Waiting for generation to start...');
        const start = Date.now();
        let lastPct = -1;
        let generationStarted = false;
        let startWaitMs = Date.now();
        const START_TIMEOUT = 30000;

        // Stall detection: if % doesn't change for 60s, re-click Generate
        let lastPctChangeTs = Date.now();
        let stallRetryCount = 0;
        const STALL_TIMEOUT = 60000;    // 1 minute
        const MAX_STALL_RETRIES = 3;

        while (Date.now() - start < timeoutMs) {
            if (STATE.status === 'cancelled') return false;

            // Check rate limit
            if (_isRateLimitReached()) {
                log('🚫 RATE LIMIT REACHED! Grok meminta upgrade ke SuperGrok.');
                STATE.status = 'rate_limited';
                STATE.error = 'Rate limit reached';
                return false;
            }

            // Check for confirmation "Generate video" button (grok.js flow)
            await checkAndClickGenerateConfirmation();

            const isGenerating = _isGeneratingOverlayVisible();
            const pctNum = _readGeneratingPercent();

            // Detect generation started
            if (!generationStarted) {
                if (isGenerating || pctNum > 0) {
                    generationStarted = true;
                    lastPctChangeTs = Date.now();
                    log('⏳ Generation started! Monitoring progress...');
                } else if (Date.now() - startWaitMs > START_TIMEOUT) {
                    const videoUrl = _getFinishedVideoUrl();
                    if (videoUrl || _isDownloadButtonVisible()) {
                        log('✅ Generation completed instantly or already done!');
                        STATE.progress = 100;
                        STATE.videoUrl = videoUrl;
                        return true;
                    }
                    log('⚠️ Generation not detected in 30s, checking if already done...');
                    generationStarted = true;
                    lastPctChangeTs = Date.now();
                }
                await sleep(1000);
                continue;
            }

            // While generating: log progress + stall detection
            if (isGenerating) {
                if (pctNum !== lastPct && pctNum > 0) {
                    STATE.progress = pctNum;
                    log(`⏳ Generating: ${pctNum}%`);
                    lastPct = pctNum;
                    lastPctChangeTs = Date.now();  // Reset stall timer
                }

                // ── STALL DETECTION: no progress change for 60s ──
                const stallElapsed = Date.now() - lastPctChangeTs;
                if (stallElapsed > STALL_TIMEOUT && stallRetryCount < MAX_STALL_RETRIES) {
                    stallRetryCount++;
                    log(`⚠️ Progress stuck at ${lastPct}% for ${Math.round(stallElapsed/1000)}s! Re-clicking Generate (retry ${stallRetryCount}/${MAX_STALL_RETRIES})...`);

                    // Re-click Generate
                    const reClicked = await clickGenerate();
                    if (reClicked) {
                        log(`🔄 Generate re-clicked (stall retry ${stallRetryCount})`);
                    } else {
                        log(`⚠️ Re-click failed, will keep waiting...`);
                    }
                    lastPctChangeTs = Date.now();  // Reset timer after retry
                    await sleep(3000);
                    continue;
                }

                await sleep(1500);
                continue;
            }

            // Not generating — check for Skip / Prefer
            const skipBtn = Array.from(document.querySelectorAll('button')).find(b =>
                (b.textContent || '').trim() === 'Skip' && isVisible(b));
            if (skipBtn) {
                log('⏭ Menerima 2 opsi video. Klik "Skip"...');
                simulateClick(skipBtn);
                STATE.progress = 99;
                await sleep(3000);
                continue;
            }
            const preferBtn = Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.textContent || '').trim().toLowerCase();
                return (t.includes('prefer this') || t.includes('suka ini')) && isVisible(b);
            });
            if (preferBtn) {
                log('💡 Menerima 2 opsi video. Klik "I prefer this"...');
                simulateClick(preferBtn);
                STATE.progress = 99;
                await sleep(3000);
                continue;
            }

            // Check for result
            const videoUrl = _getFinishedVideoUrl();
            if (videoUrl) {
                STATE.progress = 100;
                STATE.videoUrl = videoUrl;
                log(`✅ Generation complete! Video URL: ${videoUrl.substring(0, 80)}...`);
                await sleep(1500);
                return true;
            }

            if (_isDownloadButtonVisible()) {
                STATE.progress = 100;
                log('✅ Generation complete! Download button visible.');
                await sleep(1000);
                return true;
            }

            // Not generating + no result — stall detection for "overlay gone" state
            const noOverlapStall = Date.now() - lastPctChangeTs;
            if (noOverlapStall > STALL_TIMEOUT && stallRetryCount < MAX_STALL_RETRIES) {
                stallRetryCount++;
                log(`⚠️ No overlay & no result for ${Math.round(noOverlapStall/1000)}s! Re-clicking Generate (retry ${stallRetryCount}/${MAX_STALL_RETRIES})...`);
                const reClicked = await clickGenerate();
                if (reClicked) {
                    log(`🔄 Generate re-clicked`);
                    generationStarted = false;
                    startWaitMs = Date.now();
                }
                lastPctChangeTs = Date.now();
                await sleep(3000);
                continue;
            }

            // Brief race between overlay gone + video src set
            if (Date.now() - start > 10000) {
                log('⏳ Generating overlay gone, waiting for video element...');
                await sleep(2000);
                const url2 = _getFinishedVideoUrl();
                if (url2) {
                    STATE.progress = 100;
                    STATE.videoUrl = url2;
                    log(`✅ Video URL found after wait: ${url2.substring(0, 80)}...`);
                    return true;
                }
                if (_isDownloadButtonVisible()) {
                    STATE.progress = 100;
                    log('✅ Download button found after wait.');
                    return true;
                }
            }

            await sleep(1500);
        }

        log('❌ Timeout waiting for generation to complete');
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  EXTRACT VIDEO URL
    // ═══════════════════════════════════════════════════════════════
    async function extractVideoUrl() {
        log('🔍 Extracting video URL...');

        const sdVideo = $('video#sd-video');
        if (sdVideo && sdVideo.src && sdVideo.src.startsWith('https://')) {
            STATE.videoUrl = sdVideo.src;
            log(`✅ Video URL (sd-video): ${sdVideo.src.substring(0, 80)}...`);
            return sdVideo.src;
        }

        const hdVideo = $('video#hd-video');
        if (hdVideo && hdVideo.src && hdVideo.src.startsWith('https://')) {
            STATE.videoUrl = hdVideo.src;
            log(`✅ Video URL (hd-video): ${hdVideo.src.substring(0, 80)}...`);
            return hdVideo.src;
        }

        if (STATE.videoUrl && STATE.videoUrl.startsWith('https://')) {
            log(`✅ Video URL (from STATE): ${STATE.videoUrl.substring(0, 80)}...`);
            return STATE.videoUrl;
        }

        for (const v of $$('video')) {
            if (v.src && v.src.startsWith('https://') && v.src.includes('.mp4')) {
                STATE.videoUrl = v.src;
                log(`✅ Video URL (fallback): ${v.src.substring(0, 80)}...`);
                return v.src;
            }
            // Check <source> child
            const source = v.querySelector('source');
            if (source && source.src && source.src.startsWith('https://')) {
                STATE.videoUrl = source.src;
                log(`✅ Video URL (source tag): ${source.src.substring(0, 80)}...`);
                return source.src;
            }
        }

        for (const v of $$('video')) {
            if (v.src && v.src.startsWith('blob:')) {
                STATE.videoUrl = v.src;
                log('⚠️ Video is blob URL — will use download button method');
                return v.src;
            }
        }

        for (const a of $$('a[download], a[href*=".mp4"]')) {
            if (a.href && a.href.startsWith('https://')) {
                STATE.videoUrl = a.href;
                log(`✅ Video URL (download link): ${a.href.substring(0, 80)}...`);
                return a.href;
            }
        }

        log('⚠️ No video URL found');
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  EXTRACT IMAGE URLS
    // ═══════════════════════════════════════════════════════════════
    async function extractImageUrls() {
        log('🔍 Extracting image URLs...');
        const urls = [];
        for (const img of $$('article img, .grid img')) {
            const src = img.src || '';
            if (src.startsWith('https://') && src.includes('assets.grok.com') && src.length > 50) {
                urls.push(src);
            }
        }
        if (urls.length > 0) log(`✅ Found ${urls.length} image(s)`);
        return urls;
    }

    // ═══════════════════════════════════════════════════════════════
    //  DOWNLOAD — Button click + URL fallback + Anchor injection (grok.js)
    // ═══════════════════════════════════════════════════════════════
    async function clickDownloadButton() {
        log('📥 Waiting for Download button...');

        const dl = await waitForElement(
            'button[aria-label="Unduh"], button[aria-label="Download"]',
            15000,
            true
        );

        if (!dl) {
            if (STATE.videoUrl && STATE.videoUrl.startsWith('https://')) {
                log('⚠️ Download button not found, using anchor fallback (grok.js)...');
                // grok.js fallback: inject <a> tag download
                try {
                    const a = document.createElement('a');
                    a.href = STATE.videoUrl;
                    a.download = `GrokAutoV2_${Date.now()}.mp4`;
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    log('✅ Video downloaded via anchor fallback');
                } catch(e) {
                    log(`⚠️ Anchor download failed: ${e.message}`);
                }
                return true;
            }
            log('⚠️ Download button not found');
            return false;
        }

        dl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(400);
        simulateClick(dl);
        log('✅ Download (Unduh) button clicked');
        await sleep(2000);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //  MAIN GENERATE — Called from Selenium
    //  Uses grok.js automation logic with grok_auto.js robustness
    // ═══════════════════════════════════════════════════════════════
    window.__grokGenerate = async function(config) {
        /*
        config = {
            prompt: string,           // Prompt text
            mode: 'video' | 'image',  // Generation mode (default: 'video')
            image: string | null,     // Base64 image data for image-to-video
            imageName: string,        // Name for uploaded image
            timeout: number,          // Timeout in ms (default: 600000)
            upscale: boolean,         // Whether to attempt HD upscale (grok.js)
            useImageRef: boolean,     // Use "@" image referencing in prompt (grok.js, default: true when image provided)
            // Video settings:
            genMode: string,          // 'Video' or 'Image' (default: 'Video')
            resolution: string,       // '480p' or '720p' (default: '720p')
            duration: string,         // '6s' or '10s' (default: '10s')
            aspectRatio: string,      // '9:16', '16:9', '1:1', etc. (default: '9:16')
        }
        */
        STATE.status = 'running';
        STATE.progress = 0;
        STATE.videoUrl = null;
        STATE.error = null;
        STATE.downloadReady = false;
        STATE.message = 'Starting...';

        try {
            // Step 1: Navigate to /imagine
            if (!await ensureImaginePage()) {
                await sleep(3000);
                if (!location.pathname.includes('/imagine')) {
                    throw new Error('Failed to navigate to /imagine');
                }
            }
            await sleep(2000);

            if (STATE.status === 'cancelled') return STATE;

            // Step 2: Configure video settings FIRST (before image upload!)
            // Clicking radio buttons can cause React re-render which clears uploaded files
            if (config.mode !== 'image') {
                await selectVideoSettings({
                    genMode:     config.genMode     || 'Video',
                    resolution:  config.resolution  || '720p',
                    duration:    config.duration    || '10s',
                    aspectRatio: config.aspectRatio || '9:16',
                });
            }

            if (STATE.status === 'cancelled') return STATE;

            // Step 3: Upload image AFTER settings (so radio clicks don't clear it)
            const hasImage = !!config.image;
            if (hasImage) {
                const uploaded = await uploadImage(config.image, config.imageName || 'ref.jpg');
                if (!uploaded) {
                    log('⚠️ Image upload failed, continuing without image');
                }
            }

            if (STATE.status === 'cancelled') return STATE;

            // Step 4: Fill prompt — USE "@" IMAGE REFERENCING (grok.js logic)
            const useImageRef = config.useImageRef !== false && hasImage;
            const promptFilled = await fillPromptWithImageRef(config.prompt, useImageRef);
            if (!promptFilled) {
                throw new Error('Failed to fill prompt');
            }

            if (STATE.status === 'cancelled') return STATE;

            // Step 5: Click Generate (submit via Ctrl+Enter like grok.js)
            const generated = await clickGenerate();
            if (!generated) {
                throw new Error('Failed to click Generate');
            }

            // Step 6: Track progress
            await sleep(3000);
            const completed = await trackProgress(config.timeout || 600000);
            if (!completed) {
                if (STATE.status === 'cancelled') return STATE;
                if (STATE.status === 'rate_limited') return STATE;
                throw new Error('Generation timed out or failed');
            }

            // Step 7: Attempt upscale if requested (grok.js feature)
            if (config.upscale) {
                await attemptUpscale();
                // Re-extract URL after upscale
                await sleep(2000);
            }

            // Step 8: Extract result
            await sleep(2000);
            if (config.mode === 'video') {
                const url = await extractVideoUrl();
                if (url) {
                    STATE.downloadReady = true;
                }
            } else {
                const urls = await extractImageUrls();
                if (urls.length > 0) {
                    STATE.videoUrl = urls[0];
                    STATE.downloadReady = true;
                }
            }

            // Step 9: Click Download
            await clickDownloadButton();

            STATE.status = 'done';
            STATE.totalGenerated++;
            log(`✅ Generation #${STATE.totalGenerated} complete!`);
            return STATE;

        } catch (err) {
            STATE.status = 'error';
            STATE.error = err.message || String(err);
            log(`❌ Error: ${STATE.error}`);
            return STATE;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    //  CANCEL — Called from Selenium
    // ═══════════════════════════════════════════════════════════════
    window.__grokCancel = function() {
        STATE.status = 'cancelled';
        STATE.message = 'Cancelled by user';
        log('🛑 Generation cancelled');
    };

    // ═══════════════════════════════════════════════════════════════
    //  GET STATE — Called from Selenium
    // ═══════════════════════════════════════════════════════════════
    window.__grokGetState = function() {
        return { ...STATE };
    };

    // ═══════════════════════════════════════════════════════════════
    //  MULTI-TAB BATCH — Generate across multiple tabs
    //  Includes grok.js "@" image referencing logic
    // ═══════════════════════════════════════════════════════════════
    window.__grokBatchState = {
        tabs: [],
        totalDone: 0,
        totalFailed: 0,
        running: false,
    };

    window.__grokTabGenerate = async function(tabIndex, config) {
        const batch = window.__grokBatchState;
        batch.running = true;

        if (!batch.tabs[tabIndex]) {
            batch.tabs[tabIndex] = {
                tabIndex, status: 'idle', progress: 0, error: null, videoUrl: null
            };
        }
        const tabState = batch.tabs[tabIndex];
        tabState.status = 'running';
        tabState.progress = 0;
        tabState.error = null;
        tabState.videoUrl = null;

        try {
            STATE.status = 'running';
            STATE.progress = 0;
            STATE.videoUrl = null;
            STATE.error = null;

            await sleep(1000);

            // Configure video settings FIRST (before image upload!)
            if (config.mode !== 'image') {
                await selectVideoSettings({
                    genMode:     config.genMode     || 'Video',
                    resolution:  config.resolution  || '720p',
                    duration:    config.duration    || '10s',
                    aspectRatio: config.aspectRatio || '9:16',
                });
            }

            // Upload image AFTER settings (so radio clicks don't clear it)
            const hasImage = !!config.image;
            if (hasImage) {
                await uploadImage(config.image, config.imageName || 'ref.jpg');
            }

            // Fill prompt with "@" image referencing (grok.js logic)
            const useImageRef = config.useImageRef !== false && hasImage;
            const filled = await fillPromptWithImageRef(config.prompt, useImageRef);
            if (!filled) {
                tabState.status = 'error';
                tabState.error = 'Prompt fill failed';
                return tabState;
            }

            // Snapshot existing video URLs (to distinguish old vs new)
            tabState.initialVideoUrls = Array.from(document.querySelectorAll('video'))
                .map(v => v.src)
                .filter(s => s && s.includes('assets.grok.com') && s.includes('.mp4'));
            log(`[Tab ${tabIndex}] 📸 Snapshot ${tabState.initialVideoUrls.length} existing video URLs`);

            // Click generate
            const clicked = await clickGenerate();
            if (!clicked) {
                tabState.status = 'error';
                tabState.error = 'Generate click failed';
                return tabState;
            }

            tabState.status = 'generating';
            tabState._config = config;
            log(`[Tab ${tabIndex}] ✅ Generate started`);
            return tabState;

        } catch (err) {
            tabState.status = 'error';
            tabState.error = err.message || String(err);
            batch.totalFailed++;
            return tabState;
        }
    };

    // ── Check progress — SYNCHRONOUS (for Selenium execute_script) ──
    window.__grokTabCheckProgress = function(tabIndex) {
        const batch = window.__grokBatchState;
        if (!batch.tabs[tabIndex]) {
            batch.tabs[tabIndex] = {
                tabIndex, status: 'unknown', progress: 0,
                videoUrl: null, generatingOccurred: false, preferClicked: false,
                firstCheckTs: Date.now(), retryCount: 0, retrying: false,
                lastProgressTs: Date.now(), lastProgressPct: -1, stallRetryCount: 0
            };
        }
        const tabState = batch.tabs[tabIndex];

        // Init fields if missing (backward compat)
        if (!tabState.firstCheckTs) tabState.firstCheckTs = Date.now();
        if (tabState.retryCount === undefined) tabState.retryCount = 0;
        if (tabState.retrying === undefined) tabState.retrying = false;
        if (tabState.lastProgressTs === undefined) tabState.lastProgressTs = Date.now();
        if (tabState.lastProgressPct === undefined) tabState.lastProgressPct = -1;
        if (tabState.stallRetryCount === undefined) tabState.stallRetryCount = 0;

        const MAX_RETRIES = 3;
        const MAX_STALL_RETRIES = 3;
        const STALL_TIMEOUT_MS = 45000;
        const NO_OVERLAY_TIMEOUT_MS = 30000;

        // Keep terminal states
        if (tabState.status === 'done' || tabState.status === 'downloaded' ||
            tabState.status === 'error') {
            return tabState;
        }

        // 0. Check rate limit FIRST
        if (_isRateLimitReached()) {
            log(`[Tab ${tabIndex}] 🚫 RATE LIMIT REACHED!`);
            tabState.status = 'rate_limited';
            tabState.error = 'Rate limit reached';
            return tabState;
        }

        // ════ Check for "Generate video" confirmation button (grok.js) ════
        {
            const allBtns = Array.from(document.querySelectorAll('button'));
            const confirmBtn = allBtns.find(b => {
                const text = (b.innerText || b.textContent || '').trim();
                return (text.includes('Generate video') || text.includes('Buat video')) && isVisible(b);
            });
            if (confirmBtn) {
                log(`[Tab ${tabIndex}] 🔄 "Generate video" confirmation found, clicking...`);
                simulateClick(confirmBtn);
                tabState.status = 'generating';
                tabState.progress = 0;
                return tabState;
            }
        }

        // ════ 1. CHECK GENERATING OVERLAY (HIGHEST PRIORITY) ════
        const isGenerating = _isGeneratingOverlayVisible();
        const pctNum       = _readGeneratingPercent();

        if (isGenerating || pctNum > 0) {
            tabState.generatingOccurred = true;
            tabState.retrying = false;
            tabState.status   = 'generating';
            tabState.progress = pctNum;

            // Stall detection
            if (pctNum > 0 && pctNum !== tabState.lastProgressPct) {
                tabState.lastProgressPct = pctNum;
                tabState.lastProgressTs = Date.now();
            } else if (pctNum === 0 && tabState.generatingOccurred) {
                const stallElapsed = Date.now() - tabState.lastProgressTs;
                if (stallElapsed > STALL_TIMEOUT_MS && tabState.stallRetryCount < MAX_STALL_RETRIES && !tabState.retrying) {
                    tabState.stallRetryCount++;
                    tabState.retrying = true;
                    log(`[Tab ${tabIndex}] ⚠️ Progress stuck at 0% for ${Math.round(stallElapsed/1000)}s. Re-fill & retry (stall ${tabState.stallRetryCount}/${MAX_STALL_RETRIES})...`);

                    (async () => {
                        try {
                            const config = tabState._config;
                            if (config && config.prompt) {
                                const hasImage = !!config.image;
                                const useRef = config.useImageRef !== false && hasImage;
                                const filled = await fillPromptWithImageRef(config.prompt, useRef);
                                if (filled) {
                                    log(`[Tab ${tabIndex}] 📝 Prompt re-filled`);
                                } else {
                                    log(`[Tab ${tabIndex}] ⚠️ Prompt re-fill failed`);
                                }
                                await sleep(500);
                            }
                            const clicked = await clickGenerate();
                            if (clicked) {
                                log(`[Tab ${tabIndex}] 🔄 Generate re-clicked (stall retry ${tabState.stallRetryCount})`);
                                tabState.generatingOccurred = false;
                                tabState.lastProgressTs = Date.now();
                                tabState.lastProgressPct = -1;
                            }
                        } catch(e) {
                            log(`[Tab ${tabIndex}] ⚠️ Stall retry error: ${e.message}`);
                        }
                        tabState.retrying = false;
                    })();

                    return tabState;
                }
            }

            return tabState;
        }

        // ════ 2. OVERLAY GONE — Check if video is done ════
        {
            // Handle "Skip" / "I prefer this"
            if (!tabState.preferClicked) {
                const allBtns = Array.from(document.querySelectorAll('button'));

                const skipBtn = allBtns.find(b => {
                    const text = (b.textContent || '').trim();
                    return text === 'Skip' && isVisible(b);
                });

                if (skipBtn) {
                    log(`[Tab ${tabIndex}] ⏭ 2 video options. Clicking "Skip"...`);
                    simulateClick(skipBtn);
                    tabState.preferClicked = true;
                    tabState.status = 'generating';
                    tabState.progress = 99;
                    return tabState;
                }

                const preferBtn = allBtns.find(b => {
                    const text = (b.textContent || '').trim().toLowerCase();
                    return text.includes('prefer this') || text.includes('suka ini');
                });

                if (preferBtn) {
                    log(`[Tab ${tabIndex}] 💡 2 video options. Clicking "I prefer this"...`);
                    simulateClick(preferBtn);
                    tabState.preferClicked = true;
                    tabState.status = 'generating';
                    tabState.progress = 99;
                    return tabState;
                }
            } else {
                const stillHasChoiceBtns = Array.from(document.querySelectorAll('button')).some(b => {
                    const text = (b.textContent || '').trim().toLowerCase();
                    return text === 'skip' || text.includes('prefer this') || text.includes('suka ini');
                });
                if (stillHasChoiceBtns) {
                    tabState.status = 'generating';
                    tabState.progress = 99;
                    return tabState;
                }
            }

            // Check if video is done
            const finishedUrl = _getFinishedVideoUrl();
            const dlVisible   = _isDownloadButtonVisible();
            if (finishedUrl || dlVisible) {
                const initialUrls = tabState.initialVideoUrls || [];
                const isNewVideo = tabState.generatingOccurred ||
                    (finishedUrl && !initialUrls.includes(finishedUrl));
                
                const elapsedSinceFirstCheck = Date.now() - (tabState.firstCheckTs || Date.now());
                const safetyTimeout = elapsedSinceFirstCheck > 60000;

                if (isNewVideo || safetyTimeout) {
                    tabState.status   = 'done';
                    tabState.progress = 100;
                    tabState.videoUrl = finishedUrl || tabState.videoUrl;
                    if (!tabState.generatingOccurred) {
                        log(`[Tab ${tabIndex}] ✅ DONE (overlay missed — new video detected)`);
                    } else {
                        log(`[Tab ${tabIndex}] ✅ DONE (overlay gone + video confirmed)`);
                    }
                    return tabState;
                } else {
                    log(`[Tab ${tabIndex}] ⏳ Video/button visible but is old history. Waiting for new...`);
                    tabState.status = 'generating';
                    tabState.progress = 0;
                }
            }
        }

        // ════ 3. AUTO-RETRY (no overlay, no video) ════
        if (!tabState.generatingOccurred && !tabState.retrying) {
            const elapsed = Date.now() - tabState.firstCheckTs;
            if (elapsed > NO_OVERLAY_TIMEOUT_MS && tabState.retryCount < MAX_RETRIES) {
                tabState.retryCount++;
                tabState.retrying = true;
                log(`[Tab ${tabIndex}] ⚠️ No overlay after ${Math.round(elapsed/1000)}s. Re-fill & retry (${tabState.retryCount}/${MAX_RETRIES})...`);

                (async () => {
                    try {
                        const config = tabState._config;
                        if (config && config.prompt) {
                            const hasImage = !!config.image;
                            const useRef = config.useImageRef !== false && hasImage;
                            const filled = await fillPromptWithImageRef(config.prompt, useRef);
                            if (filled) {
                                log(`[Tab ${tabIndex}] 📝 Prompt re-filled`);
                            }
                            await sleep(500);
                        }
                        const clicked = await clickGenerate();
                        if (clicked) {
                            log(`[Tab ${tabIndex}] 🔄 Generate re-clicked (retry ${tabState.retryCount})`);
                        }
                    } catch(e) {
                        log(`[Tab ${tabIndex}] ⚠️ Retry error: ${e.message}`);
                    }
                    tabState.firstCheckTs = Date.now();
                    tabState.retrying = false;
                })();

                return tabState;
            }
        }

        return tabState;
    };

    // ── Download: Button click + URL fallback + Anchor injection ──
    window.__grokTabDownload = function(tabIndex) {
        const batch = window.__grokBatchState;
        if (!batch.tabs[tabIndex]) {
            batch.tabs[tabIndex] = { tabIndex, status: 'unknown', progress: 0, videoUrl: null };
        }
        const tabState = batch.tabs[tabIndex];
        tabState.status = 'downloading';

        (async () => {
            try {
                // Optional: Attempt upscale if config requested it
                const config = tabState._config;
                if (config && config.upscale) {
                    await attemptUpscale();
                    await sleep(2000);
                }

                // Find download button (poll max 20s)
                let dlBtn = null;
                const dlStart = Date.now();
                while (Date.now() - dlStart < 20000) {
                    dlBtn = _findDownloadButton();
                    if (dlBtn) break;
                    await sleep(500);
                }

                if (!dlBtn) {
                    // Fallback: download via URL (grok.js anchor injection)
                    const videoUrl = _getFinishedVideoUrl();
                    if (videoUrl) {
                        log(`[Tab ${tabIndex}] ⚠️ No download button, using anchor fallback`);
                        tabState.videoUrl = videoUrl;
                        try {
                            const a = document.createElement('a');
                            a.href = videoUrl;
                            a.download = `GrokAutoV2_${tabIndex}_${Date.now()}.mp4`;
                            a.style.display = 'none';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            log(`[Tab ${tabIndex}] ✅ Downloaded via anchor fallback`);
                        } catch(linkErr) {
                            log(`[Tab ${tabIndex}] ⚠️ Anchor download failed: ${linkErr.message}`);
                        }
                        await sleep(2000);
                        tabState.status = 'downloaded';
                        batch.totalDone++;
                        return;
                    }
                    throw new Error('Download button not found & no video URL available');
                }

                dlBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
                await sleep(500);

                try { dlBtn.click(); } catch(e) {}
                simulateClick(dlBtn);
                log(`[Tab ${tabIndex}] ✅ Download button clicked!`);

                tabState.videoUrl = _getFinishedVideoUrl() || tabState.videoUrl;
                await sleep(2000);
                tabState.status = 'downloaded';
                batch.totalDone++;
            } catch(e) {
                tabState.status = 'error';
                tabState.error  = e.message;
                batch.totalFailed++;
                log(`[Tab ${tabIndex}] ❌ Download error: ${e.message}`);
            }
        })();

        return tabState;
    };

    // ── Get video URL for Python download via requests ──
    window.__grokTabGetVideoUrl = function(tabIndex) {
        const sdVideo = document.querySelector('video#sd-video');
        if (sdVideo && sdVideo.src && sdVideo.src.startsWith('https://') && sdVideo.src.includes('.mp4')) {
            log(`[Tab ${tabIndex}] 📥 URL (sd-video): ${sdVideo.src.substring(0, 80)}...`);
            return sdVideo.src;
        }
        const hdVideo = document.querySelector('video#hd-video');
        if (hdVideo && hdVideo.src && hdVideo.src.startsWith('https://') && hdVideo.src.includes('.mp4')) {
            log(`[Tab ${tabIndex}] 📥 URL (hd-video): ${hdVideo.src.substring(0, 80)}...`);
            return hdVideo.src;
        }
        for (const v of $$('video')) {
            if (v.src && v.src.startsWith('https://') && v.src.includes('.mp4')) {
                log(`[Tab ${tabIndex}] 📥 URL (fallback): ${v.src.substring(0, 80)}...`);
                return v.src;
            }
            // Check <source> child (grok.js)
            const source = v.querySelector('source');
            if (source && source.src && source.src.startsWith('https://') && source.src.includes('.mp4')) {
                log(`[Tab ${tabIndex}] 📥 URL (source tag): ${source.src.substring(0, 80)}...`);
                return source.src;
            }
        }
        const batch = window.__grokBatchState;
        if (batch.tabs[tabIndex] && batch.tabs[tabIndex].videoUrl && 
            batch.tabs[tabIndex].videoUrl.startsWith('https://')) {
            log(`[Tab ${tabIndex}] 📥 URL (batch state): ${batch.tabs[tabIndex].videoUrl.substring(0, 80)}...`);
            return batch.tabs[tabIndex].videoUrl;
        }
        log(`[Tab ${tabIndex}] ⚠️ No video URL`);
        return null;
    };

    log('🚀 Grok Auto V2 JS injected and ready!');
})();
