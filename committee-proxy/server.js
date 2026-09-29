'use strict';
/**
 * Forex With Waqar — Multi-AI Committee Proxy (zero dependencies, Node 18+)
 *
 *  POST /api/ai   { provider, model, fallback_model, messages, max_tokens, temperature }
 *  GET  /health   { ok, providers:{groq,openai,anthropic,gemini}, auth }
 *
 *  - API keys sirf yahan (.env / hosting env vars) rehti hain, browser mein kabhi nahi.
 *  - Jis provider ki key nahi / fail ho jaye, wo seat Groq fallback par chali jati hai
 *    aur response mein _meta.fallback = true aata hai (site card par dikhata hai).
 *  - Public deploy par: Firebase login token verify hota hai + user 'approved' hona chahiye.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- tiny .env loader (existing env vars ko override nahi karta) ----------
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  raw.split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/(^|\s)#.*$/, '').trim();   // line ke aakhir ka "# comment" hata do
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
} catch (e) { /* .env optional (hosting env vars use hongi) */ }

const E = process.env;
const PROD = E.NODE_ENV === 'production';
const PORT = parseInt(E.PORT, 10) || 8787;
const HOST = E.HOST || (PROD ? '0.0.0.0' : '127.0.0.1');
const MAX_TOKENS_CAP = parseInt(E.MAX_TOKENS_CAP, 10) || 4000;
const RATE_PER_MIN = parseInt(E.RATE_LIMIT_PER_MIN, 10) || 60;
const REQUIRE_AUTH = E.REQUIRE_AUTH ? E.REQUIRE_AUTH !== 'false' : PROD;
const PROJECT_ID = E.FIREBASE_PROJECT_ID || 'forex-with-waqar';
const ADMIN_EMAILS = (E.ADMIN_EMAILS || 'ghulammurtaza3334m@gmail.com,waqarudasmalik11@gmail.com')
  .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
const ORIGINS = (E.ALLOWED_ORIGINS || '*').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const ALLOWED_GROQ = (E.ALLOWED_MODELS ||
  'llama-3.3-70b-versatile,openai/gpt-oss-120b,qwen/qwen3-32b,meta-llama/llama-4-scout-17b-16e-instruct')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

const BASE = {
  groq: E.GROQ_BASE || 'https://api.groq.com/openai/v1',
  openai: E.OPENAI_BASE || 'https://api.openai.com/v1',
  anthropic: E.ANTHROPIC_BASE || 'https://api.anthropic.com/v1',
  gemini: E.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta',
  certs: E.CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
  firestore: E.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1'
};
// Paid providers ke model IDs SERVER decide karta hai (purane/retire model ID ka masla khatam).
const MODEL = {
  openai: E.OPENAI_MODEL || 'gpt-4o-mini',
  anthropic: E.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  gemini: E.GEMINI_MODEL || 'gemini-2.5-flash'
};

function keyOf(name) {
  const v = (E[name] || '').trim();
  if (!v || /YOUR|HERE|xxx/i.test(v)) return '';
  return v;
}
function keys() {
  return { groq: keyOf('GROQ_API_KEY'), openai: keyOf('OPENAI_API_KEY'),
           anthropic: keyOf('ANTHROPIC_API_KEY'), gemini: keyOf('GEMINI_API_KEY') };
}

// ---------- helpers ----------
function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (ORIGINS.indexOf('*') !== -1) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && ORIGINS.indexOf(origin) !== -1) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function send(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(req)));
  res.end(body);
}
function errObj(msg) { return { error: { message: msg } }; }
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('Request bohot bari hai')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
function cleanText(t) {
  return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
async function fetchJson(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 45000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* non-json */ }
    return { ok: r.ok, status: r.status, json: j, text: txt, headers: r.headers };
  } finally { clearTimeout(timer); }
}
function upstreamErr(name, r) {
  const m = (r.json && (r.json.error && (r.json.error.message || r.json.error))) || r.text.slice(0, 200);
  return new Error(name + ' HTTP ' + r.status + ': ' + (typeof m === 'string' ? m : JSON.stringify(m)));
}

// ---------- rate limit ----------
const hits = new Map();
function rateOk(id) {
  const now = Date.now(); const win = 60000;
  const arr = (hits.get(id) || []).filter(function (t) { return now - t < win; });
  if (arr.length >= RATE_PER_MIN) { hits.set(id, arr); return false; }
  arr.push(now); hits.set(id, arr); return true;
}
setInterval(function () {
  const now = Date.now();
  hits.forEach(function (arr, k) { if (!arr.some(function (t) { return now - t < 60000; })) hits.delete(k); });
}, 120000).unref();

// ---------- Firebase ID token verify (RS256, Google public certs) ----------
let certCache = { certs: null, exp: 0 };
async function getCerts() {
  if (certCache.certs && Date.now() < certCache.exp) return certCache.certs;
  const r = await fetchJson(BASE.certs, {}, 10000);
  if (!r.ok || !r.json) throw new Error('Google certs load nahi hue');
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  certCache = { certs: r.json, exp: Date.now() + (m ? parseInt(m[1], 10) * 1000 : 3600000) };
  return certCache.certs;
}
function b64json(s) { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Token format ghalat');
  const header = b64json(parts[0]); const p = b64json(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Token alg ghalat');
  const certs = await getCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('Token key unknown');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1])
    .verify(pem, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Token signature ghalat');
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== PROJECT_ID || p.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('Token project ghalat');
  if (!p.sub || typeof p.sub !== 'string') throw new Error('Token subject missing');
  if (p.exp <= now) throw new Error('Token expire ho chuka');
  if (p.iat > now + 60) throw new Error('Token time ghalat');
  return p;
}
const approvedCache = new Map();
async function isApprovedUser(payload, idToken) {
  const email = String(payload.email || '').toLowerCase();
  if (payload.email_verified === true && ADMIN_EMAILS.indexOf(email) !== -1) return true;
  const c = approvedCache.get(payload.sub);
  if (c && Date.now() < c.exp) return c.ok;
  // User apna hi document Firestore rules ke tehat parh sakta hai -> user ka apna token istemal.
  const url = BASE.firestore + '/projects/' + PROJECT_ID + '/databases/(default)/documents/users/' + encodeURIComponent(payload.sub);
  const r = await fetchJson(url, { headers: { Authorization: 'Bearer ' + idToken } }, 10000);
  const ok = !!(r.ok && r.json && r.json.fields && r.json.fields.status && r.json.fields.status.stringValue === 'approved');
  approvedCache.set(payload.sub, { ok: ok, exp: Date.now() + 60000 });
  return ok;
}

// ---------- provider calls (sab normalized text return karte hain) ----------
function splitMessages(messages) {
  const sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n\n');
  const rest = messages.filter(function (m) { return m.role !== 'system'; });
  return { sys: sys, rest: rest };
}
async function callGroq(model, messages, maxTokens, temp, key) {
  const r = await fetchJson(BASE.groq + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: model, messages: messages, max_tokens: maxTokens, temperature: temp })
  });
  if (!r.ok) { const e = upstreamErr('Groq', r); e.status = r.status; throw e; }
  const t = cleanText(r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content);
  if (!t) throw new Error('Groq khaali response');
  return t;
}
async function callOpenAI(messages, maxTokens, temp, key) {
  async function once(withTemp) {
    const body = { model: MODEL.openai, messages: messages, max_completion_tokens: maxTokens };
    if (withTemp) body.temperature = temp;
    return fetchJson(BASE.openai + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
  }
  let r = await once(true);
  if (!r.ok && r.status === 400 && /temperature/i.test(r.text)) r = await once(false);
  if (!r.ok) throw upstreamErr('OpenAI', r);
  const t = cleanText(r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content);
  if (!t) throw new Error('OpenAI khaali response');
  return t;
}
async function callAnthropic(messages, maxTokens, temp, key) {
  const s = splitMessages(messages);
  const body = { model: MODEL.anthropic, max_tokens: maxTokens, temperature: Math.min(temp, 1),
                 messages: s.rest.map(function (m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; }) };
  if (s.sys) body.system = s.sys;
  const r = await fetchJson(BASE.anthropic + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw upstreamErr('Anthropic', r);
  const t = cleanText((r.json && r.json.content || []).map(function (b) { return b.type === 'text' ? b.text : ''; }).join(''));
  if (!t) throw new Error('Anthropic khaali response');
  return t;
}
async function callGemini(messages, maxTokens, temp, key) {
  const s = splitMessages(messages);
  const gen = { maxOutputTokens: maxTokens, temperature: temp };
  if (/2\.5-flash/.test(MODEL.gemini)) gen.thinkingConfig = { thinkingBudget: 0 };
  const body = { contents: s.rest.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; }),
                 generationConfig: gen };
  if (s.sys) body.systemInstruction = { parts: [{ text: s.sys }] };
  const r = await fetchJson(BASE.gemini + '/models/' + encodeURIComponent(MODEL.gemini) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw upstreamErr('Gemini', r);
  const parts = r.json && r.json.candidates && r.json.candidates[0] && r.json.candidates[0].content && r.json.candidates[0].content.parts;
  const t = cleanText((parts || []).map(function (x) { return x.text || ''; }).join(''));
  if (!t) throw new Error('Gemini khaali response');
  return t;
}
async function groqWithRetry(preferred, messages, maxTokens, temp, key) {
  const order = [preferred].concat(ALLOWED_GROQ.filter(function (m) { return m !== preferred; })).slice(0, 3);
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    try { return { text: await callGroq(order[i], messages, maxTokens, temp, key), model: order[i] }; }
    catch (e) { lastErr = e; if (e.status && e.status < 429 && e.status !== 404 && e.status !== 400) break; }
  }
  throw lastErr;
}

// ---------- validation ----------
function validate(body) {
  if (!body || typeof body !== 'object') return 'Body ghalat';
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 12) return 'messages ghalat';
  let total = 0;
  for (const m of body.messages) {
    if (!m || ['system', 'user', 'assistant'].indexOf(m.role) === -1 || typeof m.content !== 'string') return 'message format ghalat';
    total += m.content.length;
  }
  if (total > 60000) return 'messages bohot lambe hain';
  return null;
}

async function handleAI(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').toString().split(',')[0].trim();
  let who = ip;
  if (REQUIRE_AUTH) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return send(req, res, 401, errObj('Login zaroori hai (token nahi mila)'));
    let payload;
    try { payload = await verifyIdToken(token); }
    catch (e) { return send(req, res, 401, errObj('Login token qabool nahi hua: ' + e.message)); }
    let okUser = false;
    try { okUser = await isApprovedUser(payload, token); } catch (e) { okUser = false; }
    if (!okUser) return send(req, res, 403, errObj('Aapka account approved nahi hai'));
    who = payload.sub;
  }
  if (!rateOk(who)) return send(req, res, 429, errObj('Bohot zyada requests — 1 minute baad koshish karein'));

  let body;
  try { body = JSON.parse(await readBody(req, 200000)); }
  catch (e) { return send(req, res, 400, errObj('Body parse nahi hui')); }
  const bad = validate(body);
  if (bad) return send(req, res, 400, errObj(bad));

  const K = keys();
  const maxTokens = Math.max(50, Math.min(parseInt(body.max_tokens, 10) || 900, MAX_TOKENS_CAP));
  const temp = Math.max(0, Math.min(Number(body.temperature) || 0.5, 1.2));
  const provider = ['openai', 'anthropic', 'gemini', 'groq'].indexOf(body.provider) !== -1 ? body.provider : 'groq';
  const groqPref = ALLOWED_GROQ.indexOf(body.model) !== -1 ? body.model : null;
  const fbPref = ALLOWED_GROQ.indexOf(body.fallback_model) !== -1 ? body.fallback_model : ALLOWED_GROQ[0];
  const meta = { provider_used: provider, model_used: '', fallback: false, fallback_reason: '' };

  try {
    let text = '';
    if (provider !== 'groq') {
      if (!K[provider]) {
        meta.fallback = true; meta.fallback_reason = 'key set nahi';
      } else {
        try {
          if (provider === 'openai') text = await callOpenAI(body.messages, maxTokens, temp, K.openai);
          if (provider === 'anthropic') text = await callAnthropic(body.messages, maxTokens, temp, K.anthropic);
          if (provider === 'gemini') text = await callGemini(body.messages, maxTokens, temp, K.gemini);
          meta.model_used = MODEL[provider];
        } catch (e) {
          meta.fallback = true; meta.fallback_reason = e.message.slice(0, 160);
          console.warn('[' + new Date().toISOString() + '] ' + provider + ' fail -> Groq fallback: ' + meta.fallback_reason);
        }
      }
      if (meta.fallback) {
        if (!K.groq) return send(req, res, 503, errObj('Groq key bhi set nahi — proxy ki .env mein GROQ_API_KEY daalein'));
        const g = await groqWithRetry(fbPref, body.messages, maxTokens, temp, K.groq);
        text = g.text; meta.provider_used = 'groq'; meta.model_used = g.model;
      }
    } else {
      if (!K.groq) return send(req, res, 503, errObj('GROQ_API_KEY set nahi — proxy ki .env mein asli key daalein'));
      const g = await groqWithRetry(groqPref || fbPref, body.messages, maxTokens, temp, K.groq);
      text = g.text; meta.model_used = g.model;
    }
    return send(req, res, 200, { choices: [{ message: { role: 'assistant', content: text } }], _meta: meta });
  } catch (e) {
    console.error('[' + new Date().toISOString() + '] AI error: ' + e.message);
    return send(req, res, 502, errObj('AI provider error: ' + e.message.slice(0, 200)));
  }
}

const server = http.createServer(async function (req, res) {
  try {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
    if (req.method === 'GET' && url === '/health') {
      const K = keys();
      return send(req, res, 200, { ok: true, auth: REQUIRE_AUTH,
        providers: { groq: !!K.groq, openai: !!K.openai, anthropic: !!K.anthropic, gemini: !!K.gemini } });
    }
    if (req.method === 'POST' && url === '/api/ai') return await handleAI(req, res);
    return send(req, res, 404, errObj('Not found'));
  } catch (e) {
    console.error('Unhandled: ' + e.message);
    try { send(req, res, 500, errObj('Server error')); } catch (x) { /* ignore */ }
  }
});
server.listen(PORT, HOST, function () {
  const K = keys();
  console.log('Multi-AI Committee proxy chal raha hai -> http://' + HOST + ':' + PORT);
  console.log('Keys: groq=' + !!K.groq + ' openai=' + !!K.openai + ' anthropic=' + !!K.anthropic + ' gemini=' + !!K.gemini + ' | auth=' + REQUIRE_AUTH);
  if (!K.groq) console.warn('WARNING: GROQ_API_KEY set nahi — committee chal nahi sakegi.');
  if (REQUIRE_AUTH && ORIGINS.indexOf('*') !== -1) console.warn('NOTE: ALLOWED_ORIGINS=* hai; deploy par apni site ka origin daalein.');
});
