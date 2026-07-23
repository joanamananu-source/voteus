const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_FILE = process.env.VOTEUS_DATA_FILE || path.join(ROOT, 'data', 'voteus.json');
const UPLOADS_ROOT = process.env.VOTEUS_UPLOADS_DIR || path.join(ROOT, 'uploads');
const sessions = new Map();
const resetTokens = new Map();
const MAX_BODY_SIZE = 3_000_000;
const PLATFORM_FEE_RATE = 0.07;
const PAYSTACK_WITHDRAWAL_FEE_GHS = 1;
const MINIMUM_WITHDRAWAL_GHS = 50;
const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function makeId() { return crypto.randomUUID(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function readData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let updated = false;
    for (const event of data.events || []) {
      for (const nominee of event.nominees || []) {
        if (!nominee.code) { nominee.code = makeNomineeCode(event); updated = true; }
      }
    }
    if (updated) writeData(data);
    return data;
  }
  catch { return { users: [], events: [] }; }
}
function writeData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function send(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY_SIZE) { tooLarge = true; reject(new Error('Request too large')); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function safePasswordMatch(user, password) {
  if (!user || typeof password !== 'string' || typeof user.salt !== 'string' || typeof user.hash !== 'string') return false;
  const storedHash = Buffer.from(user.hash, 'hex');
  const suppliedHash = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  return storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
}
function currentUser(req, data) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = sessions.get(token);
  return data.users.find(user => user.id === userId);
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email }; }
function publicEvent(event) { return { id: event.id, name: event.name, description: event.description || '', venue: event.venue || '', eventStartAt: event.eventStartAt || null, eventEndAt: event.eventEndAt || null, imageUrl: event.imageUrl || null, startAt: event.startAt || null, endAt: event.endAt || null, createdAt: event.createdAt }; }
function makeNomineeCode(event) {
  const usedCodes = new Set((event.nominees || []).map(nominee => nominee.code));
  let code;
  do { code = `N-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; } while (usedCodes.has(code));
  return code;
}
function saveNomineeImage(imageData, nomineeId) {
  if (!imageData) return null;
  if (typeof imageData !== 'string') throw new Error('Upload a valid image file.');
  const match = imageData.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Use a PNG, JPEG, or WebP image.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 2_000_000) throw new Error('Images must be 2 MB or smaller.');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const relativePath = `/uploads/nominees/${nomineeId}.${extension}`;
  const folder = path.join(UPLOADS_ROOT, 'nominees');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${nomineeId}.${extension}`), image);
  return relativePath;
}
function saveEventImage(imageData, eventId) {
  if (!imageData) return null;
  if (typeof imageData !== 'string') throw new Error('Upload a valid event image file.');
  const match = imageData.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Use a PNG, JPEG, or WebP event image.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 2_000_000) throw new Error('Event images must be 2 MB or smaller.');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const relativePath = `/uploads/events/${eventId}.${extension}`;
  const folder = path.join(UPLOADS_ROOT, 'events');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${eventId}.${extension}`), image);
  return relativePath;
}
function managedEvent(event) {
  return {
    ...publicEvent(event), updatedAt: event.updatedAt,
    payment: event.payment || { enabled: false, amount: 0, currency: 'USD' },
    categories: Array.isArray(event.categories) ? event.categories : [],
    nominees: Array.isArray(event.nominees) ? event.nominees : [],
    tickets: Array.isArray(event.tickets) ? event.tickets : [],
    team: Array.isArray(event.team) ? event.team : []
  };
}
function requireUser(req, res, data) {
  const user = currentUser(req, data);
  if (!user) send(res, 401, { error: 'Log in to continue.' });
  return user;
}
function getBearerToken(req) { return (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function clearExpiredResetTokens() {
  for (const [token, reset] of resetTokens) if (reset.expiresAt <= Date.now()) resetTokens.delete(token);
}
function normalizeDate(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}
function normalizePayment(value) {
  if (!value || typeof value !== 'object') return { enabled: false, amount: 0, currency: 'USD' };
  const enabled = Boolean(value.enabled);
  const amount = Number(value.amount || 0);
  const currency = text(value.currency || 'USD').toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Enter a valid payment amount.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code.');
  return { enabled, amount: enabled ? amount : 0, currency };
}
function revenueSummary(event, data) {
  const paidVotes = (Array.isArray(data.votes) ? data.votes : []).filter(vote => vote.eventId === event.id && vote.payment && vote.payment.status === 'completed');
  const gross = paidVotes.reduce((total, vote) => total + Number(vote.payment.amount || 0), 0);
  const platformFee = paidVotes.reduce((total, vote) => total + Number(vote.payment.platformFee || 0), 0);
  return { paidVotes: paidVotes.length, gross, platformFee, organizerPayout: gross - platformFee, currency: (event.payment && event.payment.currency) || 'USD' };
}
function ticketAvailability(ticket) { return Math.max(0, Number(ticket.quantity || 0) - Number(ticket.sold || 0)); }
function publicTicket(ticket) { return { id: ticket.id, name: ticket.name, price: ticket.price, currency: ticket.currency, quantity: ticket.quantity, sold: Number(ticket.sold || 0), available: ticketAvailability(ticket), paymentMethod: ticket.paymentMethod || 'mobile-money', platformFeeRate: Number(ticket.platformFeeRate ?? PLATFORM_FEE_RATE) }; }
function dashboardSummary(user, data) {
  const events = data.events.filter(event => event.ownerId === user.id);
  const eventIds = new Set(events.map(event => event.id));
  const votes = (Array.isArray(data.votes) ? data.votes : []).filter(vote => eventIds.has(vote.eventId));
  const paidVotes = votes.filter(vote => vote.payment && vote.payment.status === 'completed');
  const gross = paidVotes.reduce((total, vote) => total + Number(vote.payment.amount || 0), 0);
  const platformFees = paidVotes.reduce((total, vote) => total + Number(vote.payment.platformFee || 0), 0);
  return {
    events: events.length,
    activeEvents: events.filter(canVote).length,
    categories: events.reduce((total, event) => total + (event.categories || []).length, 0),
    nominees: events.reduce((total, event) => total + (event.nominees || []).length, 0),
    votes: votes.length,
    paidVotes: paidVotes.length,
    grossIncome: gross,
    platformFees,
    organizerPayout: gross - platformFees,
    currency: events.find(event => event.payment && event.payment.enabled)?.payment.currency || 'USD'
  };
}
function withdrawalSummary(user, data) {
  const eventIds = new Set(data.events.filter(event => event.ownerId === user.id).map(event => event.id));
  const ghsEarnings = (Array.isArray(data.votes) ? data.votes : []).filter(vote => eventIds.has(vote.eventId) && vote.payment?.status === 'completed' && vote.payment.currency === 'GHS').reduce((total, vote) => total + Number(vote.payment.organizerAmount || 0), 0);
  const withdrawals = (Array.isArray(data.withdrawals) ? data.withdrawals : []).filter(withdrawal => withdrawal.ownerId === user.id);
  const committed = withdrawals.filter(withdrawal => withdrawal.status !== 'failed').reduce((total, withdrawal) => total + Number(withdrawal.amount || 0), 0);
  return { currency: 'GHS', available: Number((ghsEarnings - committed).toFixed(2)), minimum: MINIMUM_WITHDRAWAL_GHS, fee: PAYSTACK_WITHDRAWAL_FEE_GHS, withdrawals };
}
function canVote(event) {
  const now = Date.now();
  return (!event.startAt || new Date(event.startAt).getTime() <= now) && (!event.endAt || new Date(event.endAt).getTime() >= now);
}
async function api(req, res, url) {
  const data = readData();
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const { name = '', email = '', password = '', termsAccepted = false } = await readJson(req);
    const normalizedName = text(name);
    const normalizedEmail = text(email).toLowerCase();
    if (normalizedName.length < 2 || !validEmail(normalizedEmail) || typeof password !== 'string' || password.length < 8) return send(res, 400, { error: 'Enter a name, a valid email, and a password of at least 8 characters.' });
    if (!termsAccepted) return send(res, 400, { error: 'Accept the Terms & Conditions to create an account.' });
    if (data.users.some(user => user.email === normalizedEmail)) return send(res, 409, { error: 'An account already exists for this email.' });
    const passwordData = hashPassword(password);
    const user = { id: makeId(), name: normalizedName, email: normalizedEmail, termsAcceptedAt: new Date().toISOString(), termsVersion: '2026-07-23', ...passwordData, createdAt: new Date().toISOString() };
    data.users.push(user); writeData(data);
    const token = makeId(); sessions.set(token, user.id);
    return send(res, 201, { token, user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email = '', password = '' } = await readJson(req);
    const user = data.users.find(item => item.email === text(email).toLowerCase());
    if (!safePasswordMatch(user, password)) return send(res, 401, { error: 'Email or password is incorrect.' });
    const token = makeId(); sessions.set(token, user.id);
    return send(res, 200, { token, user: publicUser(user) });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = requireUser(req, res, data);
    return user && send(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/auth/profile') {
    const user = requireUser(req, res, data);
    if (!user) return;
    const { name = '', email = '' } = await readJson(req);
    const normalizedName = text(name);
    const normalizedEmail = text(email).toLowerCase();
    if (normalizedName.length < 2 || !validEmail(normalizedEmail)) return send(res, 400, { error: 'Enter a name and a valid email address.' });
    if (data.users.some(item => item.id !== user.id && item.email === normalizedEmail)) return send(res, 409, { error: 'An account already exists for this email.' });
    user.name = normalizedName;
    user.email = normalizedEmail;
    user.updatedAt = new Date().toISOString();
    writeData(data);
    return send(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard/stats') {
    const user = requireUser(req, res, data);
    return user && send(res, 200, { stats: dashboardSummary(user, data) });
  }
  if (req.method === 'GET' && url.pathname === '/api/withdrawals') {
    const user = requireUser(req, res, data);
    return user && send(res, 200, { withdrawal: withdrawalSummary(user, data) });
  }
  if (req.method === 'POST' && url.pathname === '/api/withdrawals') {
    const user = requireUser(req, res, data);
    if (!user) return;
    const { amount, method = '', mobileNetwork = '', mobileNumber = '', bankName = '', accountName = '', accountNumber = '' } = await readJson(req);
    const requested = Number(amount);
    if (!Number.isFinite(requested) || requested < MINIMUM_WITHDRAWAL_GHS) return send(res, 400, { error: `Minimum withdrawal is GHS ${MINIMUM_WITHDRAWAL_GHS.toFixed(2)}.` });
    if (text(method) !== 'mobile-money' && text(method) !== 'bank-transfer') return send(res, 400, { error: 'Choose mobile money or bank transfer.' });
    if (text(method) === 'mobile-money' && (!text(mobileNetwork) || text(mobileNumber).length < 7)) return send(res, 400, { error: 'Enter a mobile-money network and valid number.' });
    if (text(method) === 'bank-transfer' && (!text(bankName) || !text(accountName) || text(accountNumber).length < 5)) return send(res, 400, { error: 'Enter the bank name, account name, and account number.' });
    const summary = withdrawalSummary(user, data);
    if (requested > summary.available) return send(res, 400, { error: `Only GHS ${summary.available.toFixed(2)} is available to withdraw.` });
    data.withdrawals = Array.isArray(data.withdrawals) ? data.withdrawals : [];
    const withdrawal = { id: makeId(), ownerId: user.id, amount: Number(requested.toFixed(2)), fee: PAYSTACK_WITHDRAWAL_FEE_GHS, payoutAmount: Number((requested - PAYSTACK_WITHDRAWAL_FEE_GHS).toFixed(2)), currency: 'GHS', method: text(method), mobileNetwork: text(mobileNetwork), mobileNumber: text(mobileNumber), bankName: text(bankName), accountName: text(accountName), accountNumber: text(accountNumber), status: 'requested', createdAt: new Date().toISOString() };
    data.withdrawals.push(withdrawal); writeData(data);
    return send(res, 201, { message: 'Withdrawal request recorded. Paystack transfer is pending.', withdrawal });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sessions.delete(getBearerToken(req));
    return send(res, 204, null);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset') {
    const { email = '' } = await readJson(req);
    const user = data.users.find(item => item.email === text(email).toLowerCase());
    clearExpiredResetTokens();
    if (user) {
      const token = makeId();
      resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 3600000 });
      // An email provider can deliver this URL in production. Logging it keeps local development usable.
      if (process.env.NODE_ENV !== 'production') console.info(`Password reset URL: http://localhost:${PORT}/recovery.html?token=${token}`);
    }
    return send(res, 200, { message: 'If an account exists, a password reset link has been sent.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/confirm') {
    const { token = '', password = '' } = await readJson(req);
    clearExpiredResetTokens();
    const reset = resetTokens.get(text(token));
    if (!reset) return send(res, 400, { error: 'This password reset link is invalid or has expired.' });
    if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: 'Use a password of at least 8 characters.' });
    const user = data.users.find(item => item.id === reset.userId);
    if (!user) { resetTokens.delete(text(token)); return send(res, 400, { error: 'This password reset link is invalid or has expired.' }); }
    Object.assign(user, hashPassword(password));
    writeData(data);
    resetTokens.delete(text(token));
    for (const [sessionToken, userId] of sessions) if (userId === user.id) sessions.delete(sessionToken);
    return send(res, 200, { message: 'Your password has been updated. Please log in.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/events') {
    const user = requireUser(req, res, data);
    if (!user) return;
    const { name = '' } = await readJson(req);
    const normalizedName = text(name);
    if (normalizedName.length < 3) return send(res, 400, { error: 'Your event name needs at least 3 characters.' });
    const event = { id: makeId(), name: normalizedName, ownerId: user.id, description: '', venue: '', eventStartAt: null, eventEndAt: null, imageUrl: null, startAt: null, endAt: null, payment: { enabled: false, amount: 0, currency: 'USD' }, categories: [], nominees: [], tickets: [], team: [], createdAt: new Date().toISOString() };
    data.events.push(event); writeData(data);
    return send(res, 201, { event: publicEvent(event) });
  }
  if (req.method === 'GET' && url.pathname === '/api/events/mine') {
    const user = requireUser(req, res, data);
    if (!user) return;
    return send(res, 200, { events: data.events.filter(event => event.ownerId === user.id).map(publicEvent) });
  }
  const voteEventMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/vote$/i);
  if (voteEventMatch && req.method === 'GET') {
    const event = data.events.find(item => item.id === voteEventMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    const categories = Array.isArray(event.categories) ? event.categories : [];
    const nominees = (Array.isArray(event.nominees) ? event.nominees : []).map(nominee => ({ id: nominee.id, name: nominee.name, code: nominee.code || 'Code unavailable', categoryId: nominee.categoryId, photoUrl: nominee.photoUrl || null }));
    return send(res, 200, { event: { ...publicEvent(event), payment: event.payment || { enabled: false, amount: 0, currency: 'USD' }, votingOpen: canVote(event), categories, nominees } });
  }
  const votesMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/votes$/i);
  if (votesMatch && req.method === 'POST') {
    const event = data.events.find(item => item.id === votesMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (!canVote(event)) return send(res, 400, { error: 'Voting is not open for this event.' });
    const { nomineeCode = '', voterName = '', quantity = 1, payment = {} } = await readJson(req);
    const nominee = (event.nominees || []).find(item => item.code === text(nomineeCode).toUpperCase());
    if (!nominee) return send(res, 400, { error: 'Enter a valid nominee code.' });
    if (text(voterName).length < 2) return send(res, 400, { error: 'Enter your name.' });
    const voteQuantity = Number(quantity);
    if (!Number.isInteger(voteQuantity) || voteQuantity < 1 || voteQuantity > 1_000) return send(res, 400, { error: 'Choose between 1 and 1,000 votes.' });
    const requiredPayment = event.payment || { enabled: false, amount: 0, currency: 'USD' };
    if (requiredPayment.enabled && payment.status !== 'completed') return send(res, 400, { error: 'Complete payment before casting your vote.' });
    data.votes = Array.isArray(data.votes) ? data.votes : [];
    const platformFee = requiredPayment.enabled ? Number((requiredPayment.amount * PLATFORM_FEE_RATE).toFixed(2)) : 0;
    const organizerAmount = requiredPayment.enabled ? Number((requiredPayment.amount - platformFee).toFixed(2)) : 0;
    const paymentReference = requiredPayment.enabled ? makeId() : null;
    const votes = Array.from({ length: voteQuantity }, () => ({ id: makeId(), eventId: event.id, nomineeId: nominee.id, voterName: text(voterName), payment: requiredPayment.enabled ? { status: 'completed', method: text(payment.method || 'mobile-money'), mobileNumber: text(payment.mobileNumber), amount: requiredPayment.amount, currency: requiredPayment.currency, platformFee, organizerAmount, platformFeeRate: PLATFORM_FEE_RATE, reference: paymentReference } : { status: 'not-required' }, createdAt: new Date().toISOString() }));
    data.votes.push(...votes); writeData(data);
    return send(res, 201, { message: `${voteQuantity} vote${voteQuantity === 1 ? '' : 's'} recorded.`, votes: votes.map(vote => ({ id: vote.id, nomineeCode: nominee.code, payment: vote.payment })), payment: requiredPayment.enabled ? { reference: paymentReference, total: Number((requiredPayment.amount * voteQuantity).toFixed(2)), currency: requiredPayment.currency, method: text(payment.method || 'mobile-money') } : null });
  }
  const manageMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/manage$/i);
  if (manageMatch && req.method === 'GET') {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === manageMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can manage this event.' });
    return send(res, 200, { event: { ...managedEvent(event), revenue: revenueSummary(event, data) } });
  }
  const categoryMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/categories(?:\/([0-9a-f-]+))?$/i);
  if (categoryMatch) {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === categoryMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can manage this event.' });
    event.categories = Array.isArray(event.categories) ? event.categories : [];
    event.nominees = Array.isArray(event.nominees) ? event.nominees : [];
    if (req.method === 'POST' && !categoryMatch[2]) {
      const { name = '' } = await readJson(req); const normalizedName = text(name);
      if (normalizedName.length < 2) return send(res, 400, { error: 'Category names need at least 2 characters.' });
      if (event.categories.some(category => category.name.toLowerCase() === normalizedName.toLowerCase())) return send(res, 409, { error: 'That category already exists.' });
      const category = { id: makeId(), name: normalizedName };
      event.categories.push(category); event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 201, { category });
    }
    const category = event.categories.find(item => item.id === categoryMatch[2]);
    if (!category) return send(res, 404, { error: 'Category not found.' });
    if (req.method === 'PATCH') {
      const { name = '' } = await readJson(req); const normalizedName = text(name);
      if (normalizedName.length < 2) return send(res, 400, { error: 'Category names need at least 2 characters.' });
      category.name = normalizedName; event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 200, { category });
    }
    if (req.method === 'DELETE') {
      event.categories = event.categories.filter(item => item.id !== category.id);
      event.nominees = event.nominees.filter(nominee => nominee.categoryId !== category.id);
      event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 204, null);
    }
  }
  const nomineeMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/nominees(?:\/([0-9a-f-]+))?$/i);
  if (nomineeMatch) {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === nomineeMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can manage this event.' });
    event.categories = Array.isArray(event.categories) ? event.categories : [];
    event.nominees = Array.isArray(event.nominees) ? event.nominees : [];
    if (req.method === 'POST' && !nomineeMatch[2]) {
      const { name = '', categoryId = '', imageData = '' } = await readJson(req); const normalizedName = text(name);
      if (normalizedName.length < 2) return send(res, 400, { error: 'Nominee names need at least 2 characters.' });
      if (!event.categories.some(category => category.id === text(categoryId))) return send(res, 400, { error: 'Choose a valid category for this nominee.' });
      const nomineeId = makeId();
      const nominee = { id: nomineeId, name: normalizedName, code: makeNomineeCode(event), categoryId: text(categoryId), photoUrl: saveNomineeImage(imageData, nomineeId) };
      event.nominees.push(nominee); event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 201, { nominee });
    }
    const nominee = event.nominees.find(item => item.id === nomineeMatch[2]);
    if (!nominee) return send(res, 404, { error: 'Nominee not found.' });
    if (req.method === 'PATCH') {
      const { name = '', categoryId = '' } = await readJson(req); const normalizedName = text(name);
      if (normalizedName.length < 2 || !event.categories.some(category => category.id === text(categoryId))) return send(res, 400, { error: 'Enter a nominee name and choose a valid category.' });
      nominee.name = normalizedName; nominee.categoryId = text(categoryId); event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 200, { nominee });
    }
    if (req.method === 'DELETE') {
      event.nominees = event.nominees.filter(item => item.id !== nominee.id);
      event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 204, null);
    }
  }
  const ticketMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/tickets(?:\/([0-9a-f-]+))?$/i);
  if (ticketMatch) {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === ticketMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can manage tickets.' });
    event.tickets = Array.isArray(event.tickets) ? event.tickets : [];
    if (req.method === 'POST' && !ticketMatch[2]) {
      const { name = '', price, currency = 'GHS', quantity, paymentMethod = 'mobile-money' } = await readJson(req);
      const normalizedName = text(name);
      const normalizedPrice = Number(price);
      const normalizedQuantity = Number(quantity);
      const allowedCurrencies = ['USD', 'GHS', 'NGN', 'GBP', 'EUR'];
      if (normalizedName.length < 2) return send(res, 400, { error: 'Ticket names need at least 2 characters.' });
      if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) return send(res, 400, { error: 'Enter a valid ticket price.' });
      if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 1) return send(res, 400, { error: 'Available tickets must be a whole number of at least 1.' });
      if (!allowedCurrencies.includes(text(currency))) return send(res, 400, { error: 'Choose a valid ticket currency.' });
      if (text(paymentMethod) !== 'mobile-money') return send(res, 400, { error: 'Tickets are currently paid by mobile money.' });
      if (event.tickets.some(ticket => ticket.name.toLowerCase() === normalizedName.toLowerCase())) return send(res, 409, { error: 'A ticket with that name already exists.' });
      const ticket = { id: makeId(), name: normalizedName, price: Number(normalizedPrice.toFixed(2)), currency: text(currency), quantity: normalizedQuantity, paymentMethod: 'mobile-money', platformFeeRate: PLATFORM_FEE_RATE, sold: 0, createdAt: new Date().toISOString() };
      event.tickets.push(ticket); event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 201, { ticket });
    }
    const ticket = event.tickets.find(item => item.id === ticketMatch[2]);
    if (!ticket) return send(res, 404, { error: 'Ticket not found.' });
    if (req.method === 'DELETE') {
      event.tickets = event.tickets.filter(item => item.id !== ticket.id);
      event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 204, null);
    }
  }
  const publicTicketsMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/ticket-types$/i);
  if (publicTicketsMatch && req.method === 'GET') {
    const event = data.events.find(item => item.id === publicTicketsMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    return send(res, 200, { event: publicEvent(event), tickets: (event.tickets || []).map(publicTicket) });
  }
  const ticketOrderMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/tickets\/([0-9a-f-]+)\/orders$/i);
  if (ticketOrderMatch && req.method === 'POST') {
    const event = data.events.find(item => item.id === ticketOrderMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    const ticket = (event.tickets || []).find(item => item.id === ticketOrderMatch[2]);
    if (!ticket) return send(res, 404, { error: 'Ticket type not found.' });
    const { buyerName = '', quantity = 1, promoterCode = '', payment = {} } = await readJson(req);
    const normalizedBuyerName = text(buyerName);
    const quantityRequested = Number(quantity);
    if (normalizedBuyerName.length < 2) return send(res, 400, { error: 'Enter the ticket holder name.' });
    if (!Number.isInteger(quantityRequested) || quantityRequested < 1 || quantityRequested > 10) return send(res, 400, { error: 'Choose between 1 and 10 tickets.' });
    if (quantityRequested > ticketAvailability(ticket)) return send(res, 409, { error: 'Not enough tickets are available.' });
    if (Number(ticket.price) > 0 && payment.status !== 'completed') return send(res, 400, { error: 'Complete payment before issuing paid tickets.' });
    if (Number(ticket.price) > 0 && text(payment.method || 'mobile-money') !== 'mobile-money') return send(res, 400, { error: 'Pay for this ticket with mobile money.' });
    const promoter = text(promoterCode) ? (event.team || []).find(member => member.role === 'promoter' && member.accessCode === text(promoterCode).toUpperCase()) : null;
    if (text(promoterCode) && !promoter) return send(res, 400, { error: 'That promoter code is not valid for this event.' });
    const gross = Number((Number(ticket.price) * quantityRequested).toFixed(2));
    const platformFee = Number((gross * Number(ticket.platformFeeRate ?? PLATFORM_FEE_RATE)).toFixed(2));
    const order = { id: makeId(), eventId: event.id, ticketId: ticket.id, buyerName: normalizedBuyerName, quantity: quantityRequested, promoterId: promoter?.id || null, payment: Number(ticket.price) > 0 ? { status: 'completed', method: 'mobile-money', mobileNumber: text(payment.mobileNumber), gross, platformFee, organizerAmount: Number((gross - platformFee).toFixed(2)), platformFeeRate: Number(ticket.platformFeeRate ?? PLATFORM_FEE_RATE), reference: makeId() } : { status: 'not-required' }, tickets: Array.from({ length: quantityRequested }, () => ({ code: `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, checkedInAt: null, verifiedBy: null })), createdAt: new Date().toISOString() };
    data.ticketOrders = Array.isArray(data.ticketOrders) ? data.ticketOrders : [];
    data.ticketOrders.push(order); ticket.sold = Number(ticket.sold || 0) + quantityRequested; event.updatedAt = new Date().toISOString(); writeData(data);
    return send(res, 201, { order: { id: order.id, buyerName: order.buyerName, tickets: order.tickets.map(item => ({ code: item.code })), payment: order.payment } });
  }
  const ticketVerifyMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/tickets\/verify$/i);
  if (ticketVerifyMatch && req.method === 'POST') {
    const event = data.events.find(item => item.id === ticketVerifyMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    const { accessCode = '', ticketCode = '' } = await readJson(req);
    const verifier = (event.team || []).find(member => member.role === 'verifier' && member.accessCode === text(accessCode).toUpperCase());
    if (!verifier) return send(res, 403, { error: 'Use a valid ticket-verifier access code.' });
    const order = (data.ticketOrders || []).find(item => item.eventId === event.id && (item.tickets || []).some(ticket => ticket.code === text(ticketCode).toUpperCase()));
    if (!order) return send(res, 404, { error: 'Ticket not found for this event.' });
    const issuedTicket = order.tickets.find(ticket => ticket.code === text(ticketCode).toUpperCase());
    if (issuedTicket.checkedInAt) return send(res, 409, { error: 'This ticket has already been checked in.', checkedInAt: issuedTicket.checkedInAt });
    issuedTicket.checkedInAt = new Date().toISOString(); issuedTicket.verifiedBy = verifier.id; writeData(data);
    return send(res, 200, { message: 'Ticket verified. Entry approved.', ticket: { code: issuedTicket.code, buyerName: order.buyerName, checkedInAt: issuedTicket.checkedInAt, verifiedBy: verifier.name } });
  }
  const ticketOrdersMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/ticket-orders$/i);
  if (ticketOrdersMatch && req.method === 'GET') {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === ticketOrdersMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can view ticket orders.' });
    return send(res, 200, { orders: (data.ticketOrders || []).filter(order => order.eventId === event.id) });
  }
  const teamMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/team(?:\/([0-9a-f-]+))?$/i);
  if (teamMatch) {
    const user = requireUser(req, res, data);
    if (!user) return;
    const event = data.events.find(item => item.id === teamMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can manage the event team.' });
    event.team = Array.isArray(event.team) ? event.team : [];
    if (req.method === 'POST' && !teamMatch[2]) {
      const { name = '', email = '', role = '' } = await readJson(req);
      const normalizedName = text(name);
      const normalizedEmail = text(email).toLowerCase();
      const normalizedRole = text(role);
      if (normalizedName.length < 2 || !validEmail(normalizedEmail)) return send(res, 400, { error: 'Enter a name and valid email address.' });
      if (!['verifier', 'promoter'].includes(normalizedRole)) return send(res, 400, { error: 'Choose ticket verifier or promoter.' });
      if (event.team.some(member => member.email === normalizedEmail && member.role === normalizedRole)) return send(res, 409, { error: 'This person already has that event role.' });
      const prefix = normalizedRole === 'verifier' ? 'VERIFY' : 'PROMO';
      const member = { id: makeId(), name: normalizedName, email: normalizedEmail, role: normalizedRole, accessCode: `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, createdAt: new Date().toISOString() };
      event.team.push(member); event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 201, { member });
    }
    const member = event.team.find(item => item.id === teamMatch[2]);
    if (!member) return send(res, 404, { error: 'Team member not found.' });
    if (req.method === 'DELETE') {
      event.team = event.team.filter(item => item.id !== member.id);
      event.updatedAt = new Date().toISOString(); writeData(data);
      return send(res, 204, null);
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return send(res, 200, { events: data.events.map(publicEvent) });
  const eventMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)$/i);
  if (eventMatch) {
    const event = data.events.find(item => item.id === eventMatch[1]);
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (req.method === 'GET') return send(res, 200, { event: publicEvent(event) });
    const user = requireUser(req, res, data);
    if (!user) return;
    if (event.ownerId !== user.id) return send(res, 403, { error: 'Only the event owner can change this event.' });
    if (req.method === 'PATCH') {
      const { name = '', description, venue, eventStartAt, eventEndAt, imageData, startAt, endAt, payment } = await readJson(req);
      const normalizedName = text(name);
      if (normalizedName.length < 3) return send(res, 400, { error: 'Your event name needs at least 3 characters.' });
      const normalizedDescription = description === undefined ? event.description || '' : text(description);
      const normalizedVenue = venue === undefined ? event.venue || '' : text(venue);
      if (normalizedDescription.length > 2_000 || normalizedVenue.length > 200) return send(res, 400, { error: 'Keep the event description under 2,000 characters and the venue under 200 characters.' });
      const normalizedStart = normalizeDate(startAt === undefined ? event.startAt : startAt, 'Start date');
      const normalizedEnd = normalizeDate(endAt === undefined ? event.endAt : endAt, 'End date');
      if (normalizedStart && normalizedEnd && new Date(normalizedEnd) <= new Date(normalizedStart)) return send(res, 400, { error: 'The end date must be after the start date.' });
      const normalizedEventStart = normalizeDate(eventStartAt === undefined ? event.eventStartAt : eventStartAt, 'Event start date');
      const normalizedEventEnd = normalizeDate(eventEndAt === undefined ? event.eventEndAt : eventEndAt, 'Event end date');
      if (normalizedEventStart && normalizedEventEnd && new Date(normalizedEventEnd) <= new Date(normalizedEventStart)) return send(res, 400, { error: 'The event end date must be after the event start date.' });
      event.name = normalizedName; event.description = normalizedDescription; event.venue = normalizedVenue; event.eventStartAt = normalizedEventStart; event.eventEndAt = normalizedEventEnd; event.startAt = normalizedStart; event.endAt = normalizedEnd;
      if (imageData) event.imageUrl = saveEventImage(imageData, event.id);
      if (payment !== undefined) event.payment = normalizePayment(payment);
      event.updatedAt = new Date().toISOString();
      writeData(data);
      return send(res, 200, { event: publicEvent(event) });
    }
    if (req.method === 'DELETE') {
      data.events = data.events.filter(item => item.id !== event.id);
      writeData(data);
      return send(res, 204, null);
    }
  }
  return send(res, 404, { error: 'API route not found.' });
}
function serveStatic(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const staticRoot = requestPath.startsWith('/uploads/') ? UPLOADS_ROOT : ROOT;
  const relativePath = requestPath.startsWith('/uploads/') ? requestPath.slice('/uploads'.length) : requestPath;
  const filePath = path.resolve(staticRoot, `.${relativePath}`);
  if (!filePath.startsWith(staticRoot + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return send(res, error.code === 'ENOENT' ? 404 : 500, { error: 'Page not found.' });
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url); }
  catch (error) { send(res, 400, { error: error.message || 'Something went wrong.' }); }
}).listen(PORT, () => console.log(`Voteus is running at http://localhost:${PORT}`));
