// Browser-side Grok API client.
// This file is injected as raw JavaScript. Keep it free of Node/TypeScript code
// because Playwright evaluates it inside the Grok page.
(function () {
  async function generate(o) {
    const STATE = {
      status: 'running', progress: 0, message: '', videoUrl: '', videoId: '',
      assetId: '', conversationId: '', error: '', rateLimited: false, availableAt: null,
      httpStatus: 0, transientRateLimit: false, retryAfterMs: 0
    };
    window.__GROK_NEW_STATE = STATE;

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
      } finally {
        clearTimeout(timer);
      }
    }

    function parseRetryAfterMs(value) {
      if (!value) return 0;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300000, seconds * 1000);
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? Math.max(0, Math.min(300000, timestamp - Date.now())) : 0;
    }

    function markRateLimit(responseText, status, headers) {
      STATE.rateLimited = true;
      STATE.error = responseText.slice(0, 300);
      STATE.httpStatus = status || 0;
      STATE.transientRateLimit = status === 429 || /too\s+many\s+requests/i.test(responseText) || /"code"\s*:\s*8\b/.test(responseText);
      STATE.retryAfterMs = parseRetryAfterMs(headers && headers.get('Retry-After'));
      try {
        const parsed = JSON.parse(responseText);
        STATE.availableAt = parsed?.error?.availableAt || parsed?.availableAt || null;
      } catch (_) {
        STATE.availableAt = null;
      }
    }

    async function readLines(resp, onLine, shouldStop) {
      if (!resp.body) {
        const text = await resp.text();
        for (const line of text.split('\n')) {
          onLine(line);
          if (shouldStop && shouldStop()) break;
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        let timer;
        const readResult = await Promise.race([
          reader.read(),
          new Promise(resolve => { timer = setTimeout(() => resolve({ idleTimeout: true }), 30000); })
        ]);
        clearTimeout(timer);
        if (readResult.idleTimeout) {
          try { await reader.cancel(); } catch {}
          return;
        }
        const { done, value } = readResult;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          onLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (shouldStop && shouldStop()) {
            try { await reader.cancel(); } catch {}
            return;
          }
        }
      }
      if (buffer.trim()) onLine(buffer.trim());
    }

    function findVideo(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const video = findVideo(item);
          if (video) return video;
        }
        return null;
      }
      if (typeof obj.videoUrl === 'string' && obj.videoUrl.includes('generated_video')) {
        return obj.videoUrl;
      }
      for (const key of Object.keys(obj)) {
        const video = findVideo(obj[key]);
        if (video) return video;
      }
      return null;
    }

    function apiHeaders(extra) {
      const headers = Object.assign({}, o.requestMetadata || {}, {
        Accept: '*/*',
        'X-Xai-Request-Id': crypto.randomUUID()
      }, extra || {});
      if (o.statsigId) headers['X-Statsig-Id'] = o.statsigId;
      return headers;
    }

    function handleLine(line) {
      if (!line) return;
      if (line.startsWith('data:')) line = line.replace(/^data:\s*/, '').trim();
      if (!line.startsWith('{')) return;

      let parsed = null;
      try { parsed = JSON.parse(line); } catch { return; }
      const result = parsed && parsed.result;
      if (!result) return;
      if (result.conversation && result.conversation.conversationId) {
        STATE.conversationId = result.conversation.conversationId;
      }

      const response = result.response || {};
      if (response.streamingVideoGenerationResponse) {
        const streaming = response.streamingVideoGenerationResponse;
        if (typeof streaming.progress === 'number') {
          STATE.progress = Math.min(88, 38 + streaming.progress * 0.5);
        }
        if (streaming.videoUrl) STATE.videoUrl = streaming.videoUrl;
        if (streaming.videoId) STATE.videoId = streaming.videoId;
        if (streaming.progress >= 100) STATE.status = 'done';
      }
      if (response.error) STATE.error = String(response.error);
    }

    try {
      let assetId = null;
      if (o.imageData) {
        STATE.message = 'Mengunggah gambar referensi ke Grok...';
        STATE.progress = 20;
        const binary = atob(o.imageData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const form = new FormData();
        form.append('file', new File([bytes], o.imageName, { type: o.imageMime }));

        const upload = await fetchWithTimeout('https://grok.com/http/upload-file-v2/direct', {
          method: 'POST',
          headers: apiHeaders(),
          credentials: 'include',
          body: form
        }, 120000);
        const uploadText = await upload.text();
        if (!upload.ok) {
          const uploadRateLimit = upload.status === 429
            || /too\s+many\s+requests|rate\s*limit/i.test(uploadText)
            || /"code"\s*:\s*8\b/.test(uploadText);
          if (uploadRateLimit) {
            markRateLimit(uploadText, upload.status, upload.headers);
            return STATE;
          }
          throw new Error('Upload gambar gagal HTTP ' + upload.status + ': ' + uploadText.slice(0, 200));
        }
        let uploadJson = null;
        try { uploadJson = JSON.parse(uploadText); } catch {}
        assetId = (uploadJson && uploadJson.fileMetadata && uploadJson.fileMetadata.fileMetadataId)
          || (uploadJson && uploadJson.fileMetadataId) || null;
        if (!assetId) {
          throw new Error('Upload gambar tanpa fileMetadataId: ' + uploadText.slice(0, 200));
        }
        STATE.message = 'Gambar terunggah';
        STATE.progress = 28;
      }

      const body = {
        modelName: 'imagine-video-gen',
        message: o.prompt + ' --mode=custom',
        enableImageStreaming: true,
        enableSideBySide: true,
        sendFinalMetadata: true,
        responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } },
        mediaGenInput: {
          imageToVideo: {
            prompt: o.prompt,
            inputAssets: assetId ? [assetId] : [],
            aspectRatio: o.aspectRatio,
            duration: o.duration,
            resolutionName: o.resolution,
            mode: 'custom',
            skipAudio: true
          }
        },
        kind: 'CONVERSATION_KIND_IMAGINE'
      };

      STATE.message = 'Membuat permintaan generasi video...';
      STATE.progress = 32;
      const response = await fetchWithTimeout('https://grok.com/rest/app-chat/conversations/new', {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(body)
      }, 180000);
      if (!response.ok) {
        const responseText = await response.text();
        const isRateLimit = response.status === 429
          || /too\s+many\s+requests|rate\s*limit/i.test(responseText)
          || /"code"\s*:\s*8\b/.test(responseText);
        STATE.stalePage = response.status === 403
          && /out of date|reload to continue/i.test(responseText);
        if (isRateLimit) {
          markRateLimit(responseText, response.status, response.headers);
        } else {
          throw new Error('Generate video gagal HTTP ' + response.status + ': ' + responseText.slice(0, 300));
        }
        return STATE;
      }

      STATE.progress = 35;
      STATE.message = 'Memproses prompt (0 - 100%)...';
      // Grok may keep the SSE connection alive after sending the final video URL.
      // Do not wait for socket close once the result is already available.
      await readLines(response, handleLine, () => !!STATE.videoUrl || STATE.status === 'done');

      if (!STATE.videoUrl && STATE.conversationId) {
        STATE.message = 'Menunggu video (polling responses)...';
        for (let attempt = 0; attempt < 40; attempt++) {
          await sleep(3000);
          try {
            const pollResponse = await fetchWithTimeout(
              'https://grok.com/rest/app-chat/conversations/' + STATE.conversationId
                + '/responses?conversationKind=CONVERSATION_KIND_IMAGINE',
              { headers: apiHeaders(), credentials: 'include' },
              45000
            );
            const pollText = await pollResponse.text();
            let pollJson = null;
            try { pollJson = JSON.parse(pollText); } catch {}
            const video = findVideo(pollJson);
            if (video) {
              STATE.videoUrl = video;
              STATE.status = 'done';
              break;
            }
          } catch {}
        }
      }

      if (STATE.videoUrl) STATE.status = 'done';
      STATE.progress = 90;
      STATE.message = 'Selesai, siap diunduh';
    } catch (error) {
      STATE.status = 'error';
      STATE.error = String((error && error.message) || error);
    }
    return STATE;
  }

  async function readBlob(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const reader = new FileReader();
    return await new Promise(resolve => {
      reader.onloadend = () => resolve({ ok: true, data: reader.result });
      reader.onerror = () => resolve({ ok: false });
      reader.readAsDataURL(blob);
    });
  }

  async function download(relUrl) {
    if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) {
      try {
        const result = await readBlob(relUrl);
        if (result && result.ok) return result;
      } catch {}
    }
    for (const url of ['https://assets.grok.com/' + relUrl, 'https://grok.com/' + relUrl]) {
      try {
        const result = await readBlob(url);
        if (result && result.ok) return result;
      } catch {}
    }
    return { ok: false, error: 'Semua URL unduhan gagal' };
  }

  window.__GROK_API_V2_GENERATE = generate;
  window.__GROK_API_V2_DOWNLOAD = download;
})();
