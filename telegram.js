require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');

// ── CLIENTS ──────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAYMENT_LINK = process.env.PAYMENT_LINK || 'https://rzp.io/rzp/1LdgmPmV';
const TRIAL_DAYS = 7;

// ── SESSIONS ─────────────────────────────────────────────────────
const pinSessions = {};
const passwordSaveSessions = {};

// ── SEND MESSAGE ──────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ── GET OR CREATE USER ────────────────────────────────────────────
async function getOrCreateUser(chatId, firstName) {
  const phone = `tg_${chatId}`;
  let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!user) {
    const { data: newUser } = await supabase.from('users')
      .insert({ phone, agent_name: firstName || 'Saraya', plan: 'trial', trial_start: new Date().toISOString() })
      .select().single();
    user = newUser;
  }
  return user;
}

// ── CHECK ACCESS ──────────────────────────────────────────────────
function isUserActive(user) {
  if (user.plan === 'paid') return { active: true };
  if (user.plan === 'trial' || !user.plan) {
    const trialStart = new Date(user.trial_start || user.created_at);
    const now = new Date();
    const daysPassed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
    const daysLeft = TRIAL_DAYS - daysPassed;
    if (daysLeft > 0) return { active: true, trial: true, daysLeft };
    return { active: false, trial: true, daysLeft: 0 };
  }
  return { active: false };
}

// ── PASSWORD RELATED ──────────────────────────────────────────────
function isPasswordRelated(msg) {
  const lower = msg.toLowerCase();
  return lower.includes('password') || lower.includes('pass ') ||
    lower.includes('login') || lower.includes('credential') || lower.includes('secret');
}

// ── CONVERSATION ENDER ────────────────────────────────────────────
function isConversationEnder(msg) {
  const lower = msg.toLowerCase().trim();
  const enders = ['ok', 'okay', 'thanks', 'thank you', 'shukriya', 'theek hai', 'theek h',
    'accha', 'achha', 'done', 'bye', 'good', 'great', 'nice', 'perfect', '👍', '🙏', 'hmm', 'hm'];
  return enders.includes(lower);
}

// ── DETECT NAME SET ───────────────────────────────────────────────
function detectNameSet(msg) {
  const patterns = [
    /mujhe\s+(\w+)\s+bulao/i,
    /tujhe\s+(\w+)\s+bulao/i,
    /tumhara\s+(?:naam|name)\s+(\w+)\s+hai/i,
    /tera\s+(?:naam|name)\s+(\w+)\s+hai/i,
    /(\w+)\s+(?:naam|name)\s+rakho/i,
    /apna\s+(?:naam|name)\s+(\w+)\s+(?:rakho|rakh|karo|kar)/i,
    /your\s+name\s+is\s+(\w+)/i,
  ];
  for (const pattern of patterns) {
    const m = msg.match(pattern);
    if (m) return m[1];
  }
  return null;
}

// ── GENERATE EXPORT ───────────────────────────────────────────────
async function generateExport(userId, agentName, showPasswords) {
  const { data: allMemories } = await supabase.from('memories').select('*').eq('user_id', userId).order('category', { ascending: true });
  const { data: reminders } = await supabase.from('reminders').select('*').eq('user_id', userId).eq('is_sent', false);
  if (!allMemories || allMemories.length === 0) return null;

  const contacts  = allMemories.filter(m => m.category === 'contact');
  const notes     = allMemories.filter(m => m.category === 'note');
  const tasks     = allMemories.filter(m => m.category === 'task');
  const ideas     = allMemories.filter(m => m.category === 'idea');
  const expenses  = allMemories.filter(m => m.category === 'expense');
  const passwords = allMemories.filter(m => m.category === 'password');
  const general   = allMemories.filter(m => !['contact','note','task','idea','expense','password'].includes(m.category));

  let msg = `📋 *TUMHARA POORA DATA*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (contacts.length > 0)  { msg += `📞 *CONTACTS (${contacts.length})*\n`;  contacts.forEach((m,i)  => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (notes.length > 0)     { msg += `📝 *NOTES (${notes.length})*\n`;        notes.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (tasks.length > 0)     { msg += `✅ *TASKS (${tasks.length})*\n`;        tasks.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (ideas.length > 0)     { msg += `💡 *IDEAS (${ideas.length})*\n`;        ideas.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (expenses.length > 0)  { msg += `💰 *EXPENSES (${expenses.length})*\n`;  expenses.forEach((m,i)  => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (passwords.length > 0) {
    msg += `🔒 *PASSWORDS (${passwords.length})*\n`;
    if (showPasswords) { passwords.forEach((m,i) => msg += `${i+1}. 🔑 ${m.content}\n`); }
    else { msg += `_(PIN verify karo passwords dekhne ke liye)_\n`; }
    msg += `\n`;
  }
  if (general.length > 0)   { msg += `📌 *OTHER (${general.length})*\n`;      general.forEach((m,i)   => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (reminders && reminders.length > 0) {
    msg += `⏰ *UPCOMING REMINDERS (${reminders.length})*\n`;
    reminders.forEach((r,i) => { const dt = new Date(r.remind_at); msg += `${i+1}. ${r.message} — ${dt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`; });
    msg += `\n`;
  }
  const now = new Date();
  msg += `━━━━━━━━━━━━━━━━━━━━\n📅 ${now.toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Kolkata'})}\n🤖 ${agentName} Memory Assistant`;
  return msg;
}

// ── CLAUDE AI ─────────────────────────────────────────────────────
async function askClaude(userMessage, memories, agentName) {
  const memoryText = memories.length > 0
    ? memories.map((m,i) => `${i+1}. [${m.category}] ${m.content}`).join('\n')
    : 'Abhi koi memory saved nahi hai.';

  const istNow = new Date(Date.now() + 330 * 60 * 1000);
  const istTimeStr = `${String(istNow.getUTCHours()).padStart(2,'0')}:${String(istNow.getUTCMinutes()).padStart(2,'0')} IST, ${istNow.getUTCDate()}/${istNow.getUTCMonth()+1}/${istNow.getUTCFullYear()}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: `Tu ${agentName} hai — ek personal AI memory assistant. Hinglish mein baat kar (Hindi + English mix).

Abhi ka time: ${istTimeStr}

User ki saved memories:
${memoryText}

Rules:
- Save karna ho → SAVE:[category]:[content]
- Reminder → REMINDER:DATETIME|message  (pipe | se message alag karo, DATETIME mein 24-hour IST time)
  Example: REMINDER:today 18:00|Chai peena
  Example: REMINDER:tomorrow 08:30|Meeting hai
  "shaam 6 baje" = 18:00, "subah 7 baje" = 07:00, "dopahar 1 baje" = 13:00
- Kuch poochha → memory se dhundh ke answer do
- Short aur friendly reh
- Password related cheezein → alag se handle hoti hain

Example:
SAVE:contact:Rahul — 9876500000
✅ Rahul ka number save ho gaya!`,
    messages: [{ role: 'user', content: userMessage }]
  });
  return response.content[0].text;
}

// ── PROCESS CLAUDE RESPONSE ───────────────────────────────────────
async function processClaudeResponse(claudeReply, userId) {
  const lines = claudeReply.split('\n');
  let finalLines = [];
  for (const line of lines) {
    if (line.startsWith('SAVE:')) {
      const parts = line.replace('SAVE:', '').split(':');
      const category = parts[0].trim().toLowerCase();
      const content = parts.slice(1).join(':').trim();
      if (category !== 'password') {
        await supabase.from('memories').insert({ user_id: userId, category, content, is_encrypted: false });
      }
    } else if (line.startsWith('REMINDER:')) {
      const raw = line.replace('REMINDER:', '');
      let dateStr, message;
      const pipeIdx = raw.indexOf('|');
      if (pipeIdx >= 0) {
        dateStr = raw.slice(0, pipeIdx).trim();
        message  = raw.slice(pipeIdx + 1).trim();
      } else {
        // Fallback: old colon format "today 18:00:message" — grab up to HH:MM, rest is message
        const oldFmt = raw.match(/^(.*?\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)\s*:(.+)$/i);
        if (oldFmt) { dateStr = oldFmt[1].trim(); message = oldFmt[2].trim(); }
        else { const ci = raw.indexOf(':'); dateStr = ci >= 0 ? raw.slice(0, ci).trim() : raw; message = ci >= 0 ? raw.slice(ci + 1).trim() : 'Reminder'; }
      }

      const lower = dateStr.toLowerCase();
      const forcePM = lower.includes('shaam') || lower.includes('dopahar') || lower.includes('raat');
      const forceAM = lower.includes('subah') || lower.includes('savere');

      let remindAt = new Date();
      if (lower.includes('tomorrow') || lower.includes('kal')) remindAt.setUTCDate(remindAt.getUTCDate() + 1);

      let hours = -1, minutes = 0;
      const colonTime = dateStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
      if (colonTime) {
        hours = parseInt(colonTime[1]);
        minutes = parseInt(colonTime[2]);
        if (colonTime[3]) {
          if (colonTime[3].toLowerCase() === 'pm' && hours !== 12) hours += 12;
          if (colonTime[3].toLowerCase() === 'am' && hours === 12) hours = 0;
        } else if (forcePM && hours < 12) hours += 12;
        else if (forceAM && hours === 12) hours = 0;
      } else {
        const bajeMatch = dateStr.match(/(\d{1,2})\s*baje/i);
        if (bajeMatch) {
          hours = parseInt(bajeMatch[1]);
          if (forcePM && hours < 12) hours += 12;
          else if (forceAM && hours === 12) hours = 0;
        }
      }

      if (hours >= 0) {
        let utcMins = hours * 60 + minutes - 330;
        if (utcMins < 0)     { utcMins += 1440; remindAt.setUTCDate(remindAt.getUTCDate() - 1); }
        if (utcMins >= 1440) { utcMins -= 1440; remindAt.setUTCDate(remindAt.getUTCDate() + 1); }
        remindAt.setUTCHours(Math.floor(utcMins / 60), utcMins % 60, 0, 0);
      }

      await supabase.from('reminders').insert({ user_id: userId, message, remind_at: remindAt.toISOString(), is_sent: false });
    } else {
      finalLines.push(line);
    }
  }
  return finalLines.join('\n').trim() || '✅ Done!';
}

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const incomingMsg = (msg.text || '').trim();
  const firstName = msg.from.first_name || 'Friend';

  if (!incomingMsg) return;

  try {
    const user = await getOrCreateUser(chatId, firstName);
    const agentName = user.agent_name || 'Saraya';
    const lower = incomingMsg.toLowerCase();

    // ── CHECK ACCESS ──────────────────────────────────────────────
    const access = isUserActive(user);
    if (!access.active) {
      await sendMessage(chatId,
        `⏰ *Tumhara free trial khatam ho gaya!*\n\n` +
        `Saraya use karte rehne ke liye:\n💳 *₹99/month* subscribe karo:\n${PAYMENT_LINK}\n\n` +
        `Payment ke baad "paid" type karo!`
      );
      return;
    }

    // Trial warning
    if (access.trial && access.daysLeft === 1) {
      await sendMessage(chatId, `⚠️ *Kal tumhara free trial khatam ho raha hai!*\n\nContinue karne ke liye:\n${PAYMENT_LINK}`);
    }

    // ── MANUAL ACTIVATION ────────────────────────────────────────
    if (lower === 'paid' || lower === 'activate') {
      await supabase.from('users').update({ plan: 'paid' }).eq('id', user.id);
      await sendMessage(chatId, `✅ *Account activate ho gaya!*\n\nWelcome to Premium! 🎉\nAb unlimited memories use karo!`);
      return;
    }

    // ── CONVERSATION ENDER ────────────────────────────────────────
    if (isConversationEnder(incomingMsg)) {
      await sendMessage(chatId, `😊 Koi aur kaam ho to batao!`);
      return;
    }

    // ── WELCOME ───────────────────────────────────────────────────
    if (lower === 'hi' || lower === 'hello' || lower === 'start' || lower === '/start' || lower === 'hii') {
      const trialMsg = access.trial ? `\n\n⏳ *Free trial: ${access.daysLeft} din baaki*` : '';
      await sendMessage(chatId,
        `🌟 *Welcome ${firstName}!* Main tumhara personal AI memory assistant hun!\n\n` +
        `📞 Contacts\n📝 Notes\n🔒 Passwords\n⏰ Reminders${trialMsg}\n\n` +
        `Mujhe ek naam do!\nType karo: *"Mujhe [naam] bulao"*\n\nExample: "Mujhe Max bulao"`
      );
      return;
    }

    // ── SET NAME ──────────────────────────────────────────────────
    const detectedName = detectNameSet(incomingMsg);
    if (detectedName) {
      await supabase.from('users').update({ agent_name: detectedName }).eq('id', user.id);
      await sendMessage(chatId, `✨ Ab main hun *${detectedName}*! Kya yaad rakhun? 😊`);
      return;
    }

    // ── SET PIN ───────────────────────────────────────────────────
    if (lower.includes('pin set') || lower.includes('set pin')) {
      const pinMatch = incomingMsg.match(/\d{4,6}/);
      if (pinMatch) {
        const hashedPin = await bcrypt.hash(pinMatch[0], 10);
        await supabase.from('users').update({ pin: hashedPin }).eq('id', user.id);
        await sendMessage(chatId, `🔒 *PIN set ho gaya!*\n\nAb passwords safe rahenge!`);
      } else {
        await sendMessage(chatId, `PIN 4-6 digits ka hona chahiye.\nExample: "PIN set karo 1234"`);
      }
      return;
    }

    // ── PIN VERIFICATION ──────────────────────────────────────────
    if (pinSessions[chatId]) {
      const session = pinSessions[chatId];
      const pinMatch = incomingMsg.match(/^\d{4,6}$/);
      if (!pinMatch) { await sendMessage(chatId, `❌ Sirf numbers bhejo (4-6 digits):`); return; }
      if (!user.pin) { delete pinSessions[chatId]; await sendMessage(chatId, `PIN set nahi hai!\nType karo: "PIN set karo 1234"`); return; }

      const isValid = await bcrypt.compare(incomingMsg, user.pin);
      if (!isValid) { await sendMessage(chatId, `❌ *Galat PIN!* Dobara try karo:`); return; }

      if (session.action === 'view_password') {
        const { data: passwords } = await supabase.from('memories').select('*').eq('user_id', user.id).eq('category', 'password');
        delete pinSessions[chatId];
        if (!passwords || passwords.length === 0) {
          await sendMessage(chatId, `✅ *PIN correct!*\n\nKoi password saved nahi hai abhi.`);
        } else {
          const list = passwords.map((p,i) => `${i+1}. 🔑 ${p.content}`).join('\n');
          await sendMessage(chatId, `✅ *PIN correct!*\n\n*Tumhare passwords:*\n\n${list}`);
        }
        return;
      }

      if (session.action === 'export') {
        delete pinSessions[chatId];
        const exportMsg = await generateExport(user.id, agentName, true);
        await sendMessage(chatId, exportMsg ? `✅ *PIN correct!*\n\n` + exportMsg : `Koi data nahi hai abhi.`);
        return;
      }
    }

    // ── PASSWORD SAVE SESSION ─────────────────────────────────────
    if (passwordSaveSessions[chatId]) {
      const session = passwordSaveSessions[chatId];
      if (session.step === 'waiting_details') {
        // Parse "Service - Password" format
        const parts = incomingMsg.split(/\s*[-:]\s*/);
        let service, password;
        if (parts.length >= 2) {
          service = parts[0].trim();
          password = parts.slice(1).join(' - ').trim();
        } else {
          service = 'General';
          password = incomingMsg.trim();
        }
        const content = `${service}: ${password}`;
        await supabase.from('memories').insert({ user_id: user.id, category: 'password', content, is_encrypted: false });
        delete passwordSaveSessions[chatId];
        await sendMessage(chatId, `✅ *Password save ho gaya!*\n\n🔒 *${content}*`);
        return;
      }
    }

    // ── PASSWORD SAVE ─────────────────────────────────────────────
    if (isPasswordRelated(incomingMsg) && (lower.includes('save') || lower.includes('add') || lower.includes('store'))) {
      passwordSaveSessions[chatId] = { step: 'waiting_details' };
      await sendMessage(chatId,
        `🔒 *Password Save*\n\nKaun si service ka password save karna hai?\n\nIs format mein bhejo:\n*Service - Password*\n\nExample: Instagram - MyPass@123`
      );
      return;
    }

    // ── PASSWORD VIEW ─────────────────────────────────────────────
    if (isPasswordRelated(incomingMsg)) {
      if (!user.pin) {
        await sendMessage(chatId, `🔒 Pehle PIN set karo:\n*"PIN set karo 1234"*`);
        return;
      }
      pinSessions[chatId] = { action: 'view_password' };
      await sendMessage(chatId, `🔒 *Security Check!*\n\nApna PIN bhejo:`);
      return;
    }

    // ── DATA EXPORT ───────────────────────────────────────────────
    if (lower.includes('export') || lower.includes('mera data') || lower.includes('poora data') || lower.includes('sab data')) {
      if (user.pin) {
        pinSessions[chatId] = { action: 'export' };
        await sendMessage(chatId, `📋 *Data Export*\n\nPasswords bhi dekhne ke liye *PIN bhejo*\n_(Skip karna ho to "skip" bhejo)_`);
      } else {
        const exportMsg = await generateExport(user.id, agentName, false);
        await sendMessage(chatId, exportMsg || `Koi data saved nahi hai abhi!`);
      }
      return;
    }

    // ── SKIP EXPORT ───────────────────────────────────────────────
    if (lower === 'skip' && pinSessions[chatId]?.action === 'export') {
      delete pinSessions[chatId];
      const exportMsg = await generateExport(user.id, agentName, false);
      await sendMessage(chatId, exportMsg || `Koi data saved nahi hai!`);
      return;
    }

    // ── GENERAL — CLAUDE ──────────────────────────────────────────
    const { data: memories } = await supabase.from('memories').select('*')
      .eq('user_id', user.id).eq('is_encrypted', false).neq('category', 'password')
      .order('created_at', { ascending: false }).limit(50);
    const claudeReply = await askClaude(incomingMsg, memories || [], agentName);
    const finalReply = await processClaudeResponse(claudeReply, user.id);
    await sendMessage(chatId, finalReply);

  } catch (err) {
    console.error('Telegram Error:', err.message);
    try { await sendMessage(chatId, '😅 Kuch issue aaya. Thodi der baad try karo!'); } catch (e) {}
  }
});

// ── REMINDERS CRON ────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const { data: dueReminders } = await supabase.from('reminders')
    .select('*, users(phone, agent_name)')
    .eq('is_sent', false)
    .lte('remind_at', now.toISOString());

  for (const reminder of (dueReminders || [])) {
    try {
      const phone = reminder.users?.phone || '';
      if (!phone.startsWith('tg_')) continue; // Sirf Telegram users
      const chatId = phone.replace('tg_', '');
      const agentName = reminder.users?.agent_name || 'Saraya';
      await bot.sendMessage(chatId, `⏰ *Reminder from ${agentName}!*\n\n📌 ${reminder.message}`, { parse_mode: 'Markdown' });
      await supabase.from('reminders').update({ is_sent: true }).eq('id', reminder.id);
    } catch (e) { console.error('Reminder error:', e.message); }
  }
});

console.log('✅ Saraya Telegram bot chal raha hai!');
console.log('🤖 Bot: @MBmemory_bot');