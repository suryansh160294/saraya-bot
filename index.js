require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const pinSessions = {};
const PAYMENT_LINK = process.env.PAYMENT_LINK || 'https://rzp.io/rzp/1LdgmPmV';
const TRIAL_DAYS = 7;

// ── HELPERS ───────────────────────────────────────────────────────
async function sendMessage(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${to}`,
    body
  });
}

async function getOrCreateUser(phone) {
  let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!user) {
    const { data: newUser } = await supabase.from('users')
      .insert({ phone, agent_name: 'Saraya', plan: 'trial', trial_start: new Date().toISOString() })
      .select().single();
    user = newUser;
  }
  return user;
}

// Check if user is allowed to use Saraya
function isUserActive(user) {
  if (user.plan === 'paid') return { active: true };

  if (user.plan === 'trial' || !user.plan) {
    const trialStart = new Date(user.trial_start || user.created_at);
    const now = new Date();
    const daysPassed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
    const daysLeft = TRIAL_DAYS - daysPassed;

    if (daysLeft > 0) {
      return { active: true, trial: true, daysLeft };
    } else {
      return { active: false, trial: true, daysLeft: 0 };
    }
  }

  return { active: false };
}

function detectNameSet(msg) {
  const patterns = [
    /mujhe\s+(\w+)\s+bulao/i,
    /tujhe\s+(\w+)\s+bulao/i,
    /tumhara\s+(?:naam|name)\s+(\w+)\s+hai/i,
    /tera\s+(?:naam|name)\s+(\w+)\s+hai/i,
    /(\w+)\s+(?:naam|name)\s+rakho/i,
    /apna\s+(?:naam|name)\s+(\w+)\s+(?:rakho|rakh|karo|kar)/i,
  ];
  for (const pattern of patterns) {
    const m = msg.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function isPasswordRelated(msg) {
  const lower = msg.toLowerCase();
  return lower.includes('password') || lower.includes('pass ') ||
    lower.includes('login') || lower.includes('credential') || lower.includes('secret');
}


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
  if (notes.length > 0)     { msg += `📝 *NOTES (${notes.length})*\n`;        notes.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);     msg += `\n`; }
  if (tasks.length > 0)     { msg += `✅ *TASKS (${tasks.length})*\n`;        tasks.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);     msg += `\n`; }
  if (ideas.length > 0)     { msg += `💡 *IDEAS (${ideas.length})*\n`;        ideas.forEach((m,i)     => msg += `${i+1}. ${m.content}\n`);     msg += `\n`; }
  if (expenses.length > 0)  { msg += `💰 *EXPENSES (${expenses.length})*\n`;  expenses.forEach((m,i)  => msg += `${i+1}. ${m.content}\n`);  msg += `\n`; }
  if (passwords.length > 0) {
    msg += `🔒 *PASSWORDS (${passwords.length})*\n`;
    if (showPasswords) { passwords.forEach((m,i) => msg += `${i+1}. 🔑 ${m.content}\n`); }
    else { msg += `_(PIN verify karo passwords dekhne ke liye)_\n`; }
    msg += `\n`;
  }
  if (general.length > 0)   { msg += `📌 *OTHER (${general.length})*\n`;      general.forEach((m,i)   => msg += `${i+1}. ${m.content}\n`);   msg += `\n`; }
  if (reminders && reminders.length > 0) {
    msg += `⏰ *UPCOMING REMINDERS (${reminders.length})*\n`;
    reminders.forEach((r,i) => { const dt = new Date(r.remind_at); msg += `${i+1}. ${r.message} — ${dt.toLocaleString('en-IN')}\n`; });
    msg += `\n`;
  }

  const now = new Date();
  msg += `━━━━━━━━━━━━━━━━━━━━\n📅 ${now.toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})}\n🤖 ${agentName} Memory Assistant`;
  return msg;
}

async function askClaude(userMessage, memories, agentName) {
  const memoryText = memories.length > 0
    ? memories.map((m,i) => `${i+1}. [${m.category}] ${m.content}`).join('\n')
    : 'Abhi koi memory saved nahi hai.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: `Tu ${agentName} hai — ek personal AI memory assistant. Hinglish mein baat kar.

User ki saved memories:
${memoryText}

Rules:
- Save karna ho → SAVE:[category]:[content]
- Reminder → REMINDER:[datetime]:[message]
- Kuch poochha → memory se dhundh ke answer do
- Short aur friendly reh

Example:
SAVE:contact:Rahul — 9876500000
✅ Rahul ka number save ho gaya!`,
    messages: [{ role: 'user', content: userMessage }]
  });
  return response.content[0].text;
}

async function processClaudeResponse(claudeReply, userId) {
  const lines = claudeReply.split('\n');
  let finalLines = [];
  for (const line of lines) {
    if (line.startsWith('SAVE:')) {
      const parts = line.replace('SAVE:', '').split(':');
      const category = parts[0].trim().toLowerCase();
      const content = parts.slice(1).join(':').trim();
      const isPinRelated = /\bpin\b/i.test(content) && /\d{4,6}/.test(content);
      if (isPinRelated) continue;
      await supabase.from('memories').insert({ user_id: userId, category, content, is_encrypted: false });
    } else if (line.startsWith('REMINDER:')) {
      const parts = line.replace('REMINDER:', '').split(':');
      const dateStr = parts[0].trim();
      const message = parts.slice(1).join(':').trim();
      let remindAt = new Date();
      if (dateStr.toLowerCase().includes('tomorrow') || dateStr.toLowerCase().includes('kal')) remindAt.setDate(remindAt.getDate() + 1);
      const timePart = dateStr.match(/(\d+):(\d+)\s*(AM|PM|am|pm)?/);
      if (timePart) {
        let hours = parseInt(timePart[1]);
        const minutes = parseInt(timePart[2]);
        if (timePart[3] && timePart[3].toLowerCase() === 'pm' && hours !== 12) hours += 12;
        remindAt.setHours(hours, minutes, 0, 0);
      }
      await supabase.from('reminders').insert({ user_id: userId, message, remind_at: remindAt.toISOString(), is_sent: false });
    } else {
      finalLines.push(line);
    }
  }
  return finalLines.join('\n').trim() || '✅ Done!';
}

// ── MAIN WEBHOOK ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('');
  const incomingMsg = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:', '');
  if (!from || !incomingMsg) return;

  try {
    const user = await getOrCreateUser(from);
    const agentName = user.agent_name || 'Saraya';
    const lower = incomingMsg.toLowerCase();

    // ── CHECK ACCESS ──────────────────────────────────────────────
    const access = isUserActive(user);

    if (!access.active) {
      await sendMessage(from,
        `⏰ *Tumhara free trial khatam ho gaya!*\n\n` +
        `Saraya use karte rehne ke liye:\n\n` +
        `💳 *₹99/month* mein subscribe karo:\n${PAYMENT_LINK}\n\n` +
        `Payment ke baad "paid" type karo — main activate kar dunga! 🚀`
      );
      return;
    }

    // Trial warning — 1 din pehle
    if (access.trial && access.daysLeft === 1) {
      await sendMessage(from,
        `⚠️ *Kal tumhara free trial khatam ho raha hai!*\n\n` +
        `Continue karne ke liye abhi subscribe karo:\n${PAYMENT_LINK}\n\n` +
        `Sirf ₹99/month! 🎯`
      );
    }

    // ── MANUAL ACTIVATION (temporary) ────────────────────────────
    if (lower === 'paid' || lower === 'activate') {
      await supabase.from('users').update({ plan: 'paid' }).eq('id', user.id);
      await sendMessage(from,
        `✅ *Tumhara account activate ho gaya!*\n\n` +
        `Welcome to Saraya Premium! 🎉\n\n` +
        `Ab unlimited memories, passwords aur reminders use karo!`
      );
      return;
    }

    // ── WELCOME ───────────────────────────────────────────────────
    if (lower === 'hi' || lower === 'hello' || lower === 'start' || lower === 'hii') {
      const trialMsg = access.trial ? `\n\n⏳ *Free trial: ${access.daysLeft} din baaki*` : '';
      await sendMessage(from,
        `🌟 *Welcome!* Main tumhara personal AI memory assistant hun!\n\n` +
        `📞 Contacts\n📝 Notes\n🔒 Passwords\n⏰ Reminders${trialMsg}\n\n` +
        `Pehle mujhe ek naam do — jo tum chahte ho! 😊\nType karo: *"Mujhe [naam] bulao"*\n\nExample: "Mujhe Max bulao"`
      );
      return;
    }

    // ── SET NAME ──────────────────────────────────────────────────
    const detectedName = detectNameSet(incomingMsg);
    if (detectedName) {
      await supabase.from('users').update({ agent_name: detectedName }).eq('id', user.id);
      await sendMessage(from, `✨ Ab main hun *${detectedName}*! Kya yaad rakhun? 😊`);
      return;
    }

    // ── SET PIN ───────────────────────────────────────────────────
    if (lower.includes('pin set') || lower.includes('set pin')) {
      const pinMatch = incomingMsg.match(/\d{4,6}/);
      if (pinMatch) {
        const hashedPin = await bcrypt.hash(pinMatch[0], 10);
        await supabase.from('users').update({ pin: hashedPin }).eq('id', user.id);
        await sendMessage(from, `🔒 *PIN set ho gaya!*\n\nAb passwords safe rahenge!`);
      } else {
        await sendMessage(from, `PIN 4-6 digits ka hona chahiye.\nExample: "PIN set karo 1234"`);
      }
      return;
    }

    // ── PIN VERIFICATION ──────────────────────────────────────────
    if (pinSessions[from]) {
      // Guided password info collection — not a PIN input
      if (pinSessions[from].action === 'awaiting_password_info') {
        const separatorMatch = incomingMsg.match(/^(.+?)\s*[-:]\s*(.+)$/);
        if (!separatorMatch) {
          await sendMessage(from, `Format samajh nahi aaya.\n\nIs format mein bhejo:\n*Service - Password*\n\nExample: Instagram - MyPass@123`);
          return;
        }
        const service = separatorMatch[1].trim();
        const password = separatorMatch[2].trim();
        const structured = `${service}: ${password}`;
        pinSessions[from] = { action: 'save_password', data: structured };
        await sendMessage(from, `🔒 *Security Check!*\n\nSave karunga:\n*${structured}*\n\nApna PIN bhejo:`);
        return;
      }

      const session = pinSessions[from];
      const pinMatch = incomingMsg.match(/^\d{4,6}$/);
      if (!pinMatch) { await sendMessage(from, `❌ Sirf numbers bhejo (4-6 digits):`); return; }
      if (!user.pin) { delete pinSessions[from]; await sendMessage(from, `PIN set nahi hai!\nType karo: "PIN set karo 1234"`); return; }

      const isValid = await bcrypt.compare(incomingMsg, user.pin);
      if (!isValid) { await sendMessage(from, `❌ *Galat PIN!* Dobara try karo:`); return; }

      if (session.action === 'save_password') {
        await supabase.from('memories').insert({ user_id: user.id, category: 'password', content: session.data, is_encrypted: false });
        delete pinSessions[from];
        await sendMessage(from, `✅ *PIN correct!*\n\n🔒 Password save ho gaya:\n*${session.data}*`);
        return;
      }
      if (session.action === 'view_password') {
        const { data: passwords } = await supabase.from('memories').select('*').eq('user_id', user.id).eq('category', 'password');
        delete pinSessions[from];
        if (!passwords || passwords.length === 0) {
          await sendMessage(from, `✅ *PIN correct!*\n\nKoi password saved nahi hai abhi.`);
        } else {
          const list = passwords.map((p,i) => `${i+1}. 🔑 ${p.content}`).join('\n');
          await sendMessage(from, `✅ *PIN correct!*\n\n*Tumhare passwords:*\n\n${list}`);
        }
        return;
      }
      if (session.action === 'export') {
        delete pinSessions[from];
        const exportMsg = await generateExport(user.id, agentName, true);
        await sendMessage(from, exportMsg ? `✅ *PIN correct!*\n\n` + exportMsg : `Koi data nahi hai abhi.`);
        return;
      }
    }

    // ── PASSWORD SAVE ─────────────────────────────────────────────
    if (isPasswordRelated(incomingMsg) && (lower.includes('save') || lower.includes('add') || lower.includes('store'))) {
      if (!user.pin) { await sendMessage(from, `🔒 Pehle PIN set karo:\n*"PIN set karo 1234"*`); return; }
      pinSessions[from] = { action: 'awaiting_password_info' };
      await sendMessage(from, `🔒 *Password Save*\n\nKaun si service ka password save karna hai?\n\nIs format mein bhejo:\n*Service - Password*\n\nExample: Instagram - MyPass@123`);
      return;
    }

    // ── PASSWORD VIEW ─────────────────────────────────────────────
    if (isPasswordRelated(incomingMsg)) {
      if (!user.pin) { await sendMessage(from, `🔒 Pehle PIN set karo:\n*"PIN set karo 1234"*`); return; }
      pinSessions[from] = { action: 'view_password', data: incomingMsg };
      await sendMessage(from, `🔒 *Security Check!*\n\nApna PIN bhejo:`);
      return;
    }

    // ── DATA EXPORT ───────────────────────────────────────────────
    if (lower.includes('export') || lower.includes('mera data') || lower.includes('poora data') || lower.includes('sab data')) {
      if (user.pin) {
        pinSessions[from] = { action: 'export', data: 'export' };
        await sendMessage(from, `📋 *Data Export*\n\nPasswords bhi dekhne ke liye *PIN bhejo*\n_(Skip karna ho to "skip" bhejo)_`);
      } else {
        const exportMsg = await generateExport(user.id, agentName, false);
        await sendMessage(from, exportMsg || `Koi data saved nahi hai abhi!`);
      }
      return;
    }

    // ── SKIP EXPORT ───────────────────────────────────────────────
    if (lower === 'skip' && pinSessions[from]?.action === 'export') {
      delete pinSessions[from];
      const exportMsg = await generateExport(user.id, agentName, false);
      await sendMessage(from, exportMsg || `Koi data saved nahi hai!`);
      return;
    }

    // ── CONVERSATION ENDERS ───────────────────────────────────────
    const enders = ['ok', 'okay', 'thanks', 'thank you', 'theek hai', 'theek h', 'accha', 'achha', 'done', 'shukriya', 'shukriyaa', 'bye', 'alvida', '👍', '🙏', 'hmm', 'hm', 'alright'];
    if (enders.includes(lower) || lower === '👍🏻' || lower === '👍🏼') {
      await sendMessage(from, `😊 Koi aur kaam ho to batao!`);
      return;
    }

    // ── GENERAL — CLAUDE ──────────────────────────────────────────
    const { data: memories } = await supabase.from('memories').select('*').eq('user_id', user.id).eq('is_encrypted', false).neq('category', 'password').order('created_at', { ascending: false }).limit(50);
    const claudeReply = await askClaude(incomingMsg, memories || [], agentName);
    const finalReply = await processClaudeResponse(claudeReply, user.id);
    await sendMessage(from, finalReply);

  } catch (err) {
    console.error('Error:', err.message);
    try { await sendMessage(from, '😅 Kuch issue aaya. Thodi der baad try karo!'); } catch (e) {}
  }
});

// ── TRIAL EXPIRY CHECK (daily at 9am) ────────────────────────────
cron.schedule('0 9 * * *', async () => {
  const now = new Date();
  const { data: trialUsers } = await supabase.from('users').select('*').eq('plan', 'trial');
  for (const user of (trialUsers || [])) {
    const trialStart = new Date(user.trial_start || user.created_at);
    const daysPassed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
    if (daysPassed === 6) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:${user.phone}`,
          body: `⚠️ *Kal tumhara free trial khatam ho raha hai!*\n\nSaraya use karte rehne ke liye:\n💳 *₹99/month*:\n${PAYMENT_LINK}`
        });
      } catch (e) {}
    }
  }
});

// ── REMINDERS CRON (every minute) ────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const { data: dueReminders } = await supabase.from('reminders').select('*, users(phone, agent_name)').eq('is_sent', false).lte('remind_at', now.toISOString());
  for (const reminder of (dueReminders || [])) {
    try {
      const agentName = reminder.users?.agent_name || 'Saraya';
      await sendMessage(reminder.users.phone, `⏰ *Reminder from ${agentName}!*\n\n📌 ${reminder.message}`);
      await supabase.from('reminders').update({ is_sent: true }).eq('id', reminder.id);
    } catch (e) { console.error('Reminder error:', e.message); }
  }
});

// ── CLEANUP: remove any PIN entries accidentally saved in memories ─
(async () => {
  try {
    const { data: pinEntries } = await supabase.from('memories').select('id, content').ilike('content', '%pin%');
    const toDelete = (pinEntries || []).filter(e => /\d{4,6}/.test(e.content));
    if (toDelete.length > 0) {
      await supabase.from('memories').delete().in('id', toDelete.map(e => e.id));
      console.log(`🧹 ${toDelete.length} PIN entries memories se hataaye`);
    }
  } catch (e) { console.error('PIN cleanup error:', e.message); }
})();

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Saraya bot chal raha hai — Port ${PORT}`);
});