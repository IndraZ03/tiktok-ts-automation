// leonardo-helper.ts
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface LeonardoAccount {
  id: string;
  name: string;
  cookies: string;
  isActive: boolean;
  email?: string;
  credits?: number;
}

export interface LeonardoPrompt {
  id: string;
  name: string;
  prompt: string;
}

export interface LeonardoData {
  accounts: LeonardoAccount[];
  prompts: LeonardoPrompt[];
}

const DATA_FILE = path.join(__dirname, 'leonardo-data.json');
export const LEONARDO_DOWNLOAD_DIR = path.join(__dirname, 'public', 'leonardo-downloads');

// Ensure directories exist
if (!fs.existsSync(LEONARDO_DOWNLOAD_DIR)) {
  fs.mkdirSync(LEONARDO_DOWNLOAD_DIR, { recursive: true });
}

// ─── DATABASE OPERATIONS ─────────────────────────────────

export function loadLeonardoData(): LeonardoData {
  if (!fs.existsSync(DATA_FILE)) {
    const initialData: LeonardoData = { accounts: [], prompts: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading leonardo-data.json, resetting:', err);
    return { accounts: [], prompts: [] };
  }
}

export function saveLeonardoData(data: LeonardoData) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── JWT RESOLVER & UTILS ────────────────────────────────

function findJWTs(obj: any, found: string[] = []) {
  if (typeof obj === 'string') {
    const parts = obj.split('.');
    if (parts.length === 3 && parts.every(p => /^[a-zA-Z0-9_-]+$/.test(p))) {
      found.push(obj);
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      findJWTs(obj[key], found);
    }
  }
  return found;
}

function scoreToken(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    
    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now + 120) {
      return 0; // Expired or close (less than 2 mins left)
    }

    const tokenUse = (payload.token_use || '').toLowerCase();
    
    // Pastikan ini adalah token Cognito/Leonardo yang valid (baik id maupun access token)
    // dan saring token-token lain yang tidak kompatibel seperti Cloudflare Access Token (CF_Access_Token)
    const iss = (payload.iss || '').toLowerCase();
    const isCognito = iss.includes('cognito-idp') || !!payload['cognito:username'] || tokenUse === 'access' || tokenUse === 'id';
    if (!isCognito) {
      return 0;
    }

    // Berikan skor. Access token diberi peringkat lebih tinggi (3), ID token diberi peringkat (2)
    let score = 1;
    if (tokenUse === 'access') {
      score = 3;
    } else if (tokenUse === 'id') {
      score = 2;
    }

    if (payload.iss && payload.iss.includes('cognito-idp')) {
      score += 2;
    }
    if (payload['cognito:username']) {
      score += 1;
    }

    return score;
  } catch (err) {
    return 0;
  }
}

export async function getFreshJWT(cookieString: string): Promise<string> {
  // Bersihkan label cookie= dari awal string jika ada
  let cleanedString = cookieString.trim();
  if (cleanedString.toLowerCase().startsWith('cookie=')) {
    cleanedString = cleanedString.substring(7).trim();
  }

  // 1. STRATEGI UTAMA: Ekstraksi langsung jika input mengandung token JWT Access yang valid
  // (misal: disalin beserta token=eyJ... di akhir)
  const jwtRegex = /(?:token|bearer)?\s*=\s*(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/i;
  const match = cleanedString.match(jwtRegex);
  if (match && match[1]) {
    const directToken = match[1];
    if (scoreToken(directToken) > 0) {
      console.log("✓ Berhasil mengekstrak JWT Access valid langsung dari pattern token=eyJ!");
      return directToken;
    }
  }

  // Cari di potongan kata/pecahan semi-kolon atau spasi apa saja untuk JWT valid
  const parts = cleanedString.split(/\s+|;/);
  for (const p of parts) {
    const cleaned = p.trim().replace(/^(token|bearer)=/i, '');
    if (cleaned.split('.').length === 3 && scoreToken(cleaned) > 0) {
      console.log("✓ Berhasil mengekstrak JWT Access valid dari pecahan string!");
      return cleaned;
    }
  }

  // 2. STRATEGI CADANGAN: Jika tidak ada token JWT Access langsung, gunakan browser automation dengan BYPASS addCookies API
  console.log("⏳ Menjalankan browser automation headless...");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Buka domain Leonardo terlebih dahulu agar context berada di origin yang tepat
    await page.goto('https://app.leonardo.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Set cookies langsung ke document.cookie di dalam konteks halaman browser
    // Ini mem-bypass kegagalan dan validasi ketat dari API browserContext.addCookies()!
    await page.evaluate((cookieStr) => {
      const cookies = cookieStr.split(/;|\s+(?=[a-zA-Z0-9._-]+[=])/);
      for (const c of cookies) {
        const trimmed = c.trim();
        if (trimmed) {
          document.cookie = trimmed + "; domain=.leonardo.ai; path=/; secure; SameSite=Lax";
        }
      }
    }, cleanedString);
    
    // Attempt to hit Better-Auth get-session
    await page.goto('https://app.leonardo.ai/api/auth/get-session', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.textContent('body');
    if (!content) throw new Error('Empty response body from Better-Auth session API');
    
    let sessionData;
    try {
      sessionData = JSON.parse(content);
    } catch {
      throw new Error('Better-Auth returned non-JSON content. Cookie might be invalid or blocked.');
    }

    const jwts = findJWTs(sessionData);
    if (jwts.length === 0) {
      // Fallback Strategy B: Try Next-Auth session endpoint
      await page.goto('https://app.leonardo.ai/api/auth/session', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const legacyContent = await page.textContent('body');
      if (legacyContent) {
        try {
          const legacyData = JSON.parse(legacyContent);
          findJWTs(legacyData, jwts);
        } catch {}
      }
    }

    if (jwts.length === 0) {
      throw new Error('Gagal mengekstrak JWT Bearer token dari session Leonardo. Pastikan Cookie Anda valid dan masih aktif.');
    }

    // Score and select best token
    const scored = jwts.map(token => ({ token, score: scoreToken(token) }))
                       .filter(t => t.score > 0);
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      throw new Error('Semua token JWT yang ditemukan sudah kedaluwarsa atau bukan Access Token.');
    }

    return scored[0].token;
  } finally {
    await browser.close();
  }
}

// ─── GRAPHQL API CORE ───────────────────────────────────

export async function sendGraphQLRequest(token: string, payload: any) {
  const res = await fetch('https://api.leonardo.ai/v1/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-leo-schema-version': 'latest',
      'Origin': 'https://app.leonardo.ai',
      'Referer': 'https://app.leonardo.ai/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL Error: HTTP ${res.status} - ${text}`);
  }

  const json = await res.json() as any;
  if (json.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

// ─── ACCOUNT CREDIT & DETAILS ───────────────────────────

export async function fetchCreditBalance(token: string): Promise<{ email: string; credits: number }> {
  let userSub = '';
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      userSub = payload.sub || '';
    }
  } catch {}

  const primaryQuery = `
    query GetUserDetails($userSub: String) {
      users(where: {user_details: {cognitoId: {_eq: $userSub}}}) {
        user_details {
          subscriptionTokens
          paidTokens
          rolloverTokens
          auth0Email
        }
      }
    }
  `;

  try {
    const response = await sendGraphQLRequest(token, {
      operationName: "GetUserDetails",
      query: primaryQuery,
      variables: { userSub }
    });

    const user = response.data?.users?.[0];
    const details = user?.user_details?.[0];

    if (details) {
      const totalCredits = (details.subscriptionTokens || 0) + 
                           (details.paidTokens || 0) + 
                           (details.rolloverTokens || 0);
      return {
        email: details.auth0Email || 'Unknown Email',
        credits: totalCredits
      };
    }
  } catch (error: any) {
    console.warn("Primary credit query GetUserDetails failed, trying fallback...", error.message);
  }

  const fallbackQuery = `
    query GetTokenBalance {
      user_details {
        subscriptionTokens
        paidTokens
        rolloverTokens
        auth0Email
      }
    }
  `;

  const responseFallback = await sendGraphQLRequest(token, {
    operationName: "GetTokenBalance",
    query: fallbackQuery,
    variables: {}
  });

  const details = responseFallback.data?.user_details?.[0];
  if (!details) throw new Error("Gagal mengambil informasi kredit dari data user_details.");

  const totalCredits = (details.subscriptionTokens || 0) + 
                       (details.paidTokens || 0) + 
                       (details.rolloverTokens || 0);
  return {
    email: details.auth0Email || 'Unknown Email',
    credits: totalCredits
  };
}

// ─── IMAGE UPLOAD REST / S3 ──────────────────────────────

export async function uploadInitImage(token: string, filePath: string): Promise<string> {
  const extension = path.extname(filePath).replace('.', '').toLowerCase();
  
  // 1. Get Presigned S3 URL from REST API
  const res = await fetch('https://api.leonardo.ai/api/rest/v1/init-image', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://app.leonardo.ai',
      'Referer': 'https://app.leonardo.ai/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ extension })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to request presigned upload URL: HTTP ${res.status} - ${text}`);
  }

  const json = (await res.json()) as any;
  // Standard fields are inside uploadInitImage object or directly inside root
  const initImage = json.uploadInitImage || json;
  const imageId = initImage.id || initImage.imageId;

  if (!imageId) {
    throw new Error(`Invalid init-image response (missing ID) from Leonardo API: ${JSON.stringify(json)}`);
  }

  let contentType = 'image/png';
  if (['jpg', 'jpeg'].includes(extension)) contentType = 'image/jpeg';
  else if (extension === 'webp') contentType = 'image/webp';

  const fileBuffer = fs.readFileSync(filePath);

  // Cek apakah response menggunakan skema Web App (url + fields string) atau Developer API (uploadUrl)
  if (initImage.fields && initImage.url) {
    // ─── SKEMA A: S3 Presigned POST (Web App / Cognito JWT) ───
    console.log("⚡ Menggunakan skema S3 Presigned POST (Web App)...");
    const formData = new FormData();
    let fieldsObj: Record<string, string> = {};
    try {
      fieldsObj = typeof initImage.fields === 'string' ? JSON.parse(initImage.fields) : initImage.fields;
    } catch (err) {
      console.warn("Failed to parse fields JSON, using raw object if available", err);
      fieldsObj = initImage.fields;
    }

    for (const [key, val] of Object.entries(fieldsObj)) {
      formData.append(key, val);
    }

    // Tambahkan file biner sebagai Blob
    const blob = new Blob([fileBuffer], { type: contentType });
    formData.append('file', blob, path.basename(filePath));

    const s3Res = await fetch(initImage.url, {
      method: 'POST',
      body: formData
    });

    if (!s3Res.ok) {
      const text = await s3Res.text();
      throw new Error(`S3 POST image upload failed: HTTP ${s3Res.status} - ${text}`);
    }
  } else if (initImage.uploadUrl) {
    // ─── SKEMA B: S3 Presigned PUT (Developer API / uploadUrl) ───
    console.log("⚡ Menggunakan skema S3 Presigned PUT (Developer API)...");
    const s3Res = await fetch(initImage.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType
      },
      body: fileBuffer
    });

    if (!s3Res.ok) {
      const text = await s3Res.text();
      throw new Error(`S3 PUT image upload failed: HTTP ${s3Res.status} - ${text}`);
    }
  } else {
    throw new Error(`Invalid init-image response (missing both fields/url and uploadUrl) from Leonardo API: ${JSON.stringify(json)}`);
  }

  return imageId;
}

// ─── KLING VIDEO GENERATION ──────────────────────────────

export async function triggerKlingGenerate(token: string, options: {
  prompt: string;
  imageId?: string;
  duration: number;
  width: number;
  height: number;
  mode: string;
  motion_has_audio: boolean;
}): Promise<string> {
  const parameters: any = {
    width: options.width,
    height: options.height,
    duration: options.duration,
    mode: options.mode,
    motion_has_audio: options.motion_has_audio,
    quantity: 1,
    prompt: options.prompt
  };

  if (options.imageId) {
    parameters.guidances = {
      start_frame: [
        {
          image: {
            id: options.imageId,
            type: "UPLOADED"
          }
        }
      ]
    };
  }

  const query = `
    mutation Generate($request: CreateGenerationRequest!) {
      generate(request: $request) {
        apiCreditCost
        generationId
        __typename
      }
    }
  `;

  const variables = {
    request: {
      model: "kling-3.0",
      public: true,
      parameters
    }
  };

  const response = await sendGraphQLRequest(token, {
    operationName: "Generate",
    query,
    variables
  });

  const generationId = response.data?.generate?.generationId;
  if (!generationId) {
    throw new Error(`Failed to request video generation: ${JSON.stringify(response)}`);
  }

  return generationId;
}

export async function checkGenerationStatus(token: string, generationId: string): Promise<string> {
  const query = `
    query GetAIGenerationFeedStatuses($where: generations_bool_exp = {}) {
      generations(where: $where) {
        id
        status
        __typename
      }
    }
  `;

  const variables = {
    where: {
      id: {
        _eq: generationId
      }
    }
  };

  const response = await sendGraphQLRequest(token, {
    operationName: "GetAIGenerationFeedStatuses",
    query,
    variables
  });

  const gen = response.data?.generations?.[0];
  if (!gen) {
    throw new Error(`Generation job dengan ID ${generationId} tidak ditemukan.`);
  }

  return gen.status;
}

export async function fetchGenerationVideoUrl(token: string, generationId: string): Promise<{ videoUrl: string; thumbnailUrl?: string }> {
  const query = `
    query GetVideoGenerationFeed($where: generations_bool_exp = {}, $limit: Int) {
      generations(where: $where, limit: $limit) {
        id
        status
        generated_images {
          id
          url
          motionMP4URL
        }
      }
    }
  `;

  const variables = {
    where: {
      id: {
        _eq: generationId
      }
    },
    limit: 1
  };

  const response = await sendGraphQLRequest(token, {
    operationName: "GetVideoGenerationFeed",
    query,
    variables
  });

  const gen = response.data?.generations?.[0];
  if (!gen) throw new Error(`Hasil generation untuk ID ${generationId} tidak ditemukan.`);
  
  const img = gen.generated_images?.[0];
  const videoUrl = img?.motionMP4URL;
  const thumbnailUrl = img?.url;

  if (!videoUrl) {
    throw new Error(`Video URL (motionMP4URL) tidak ditemukan. Response: ${JSON.stringify(response)}`);
  }

  return { videoUrl, thumbnailUrl };
}

// ─── DOWNLOAD VIDEO TO LOCAL STATIC ──────────────────────

export async function downloadVideoToLocal(videoUrl: string, generationId: string): Promise<string> {
  const filename = `leonardo-${generationId}-${Date.now()}.mp4`;
  const destPath = path.join(LEONARDO_DOWNLOAD_DIR, filename);

  const res = await fetch(videoUrl);
  if (!res.ok) {
    throw new Error(`Gagal mengunduh file video dari S3: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(destPath, buffer);

  return `/leonardo-downloads/${filename}`;
}
