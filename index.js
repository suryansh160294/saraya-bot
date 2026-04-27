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
    const { data: newUser } = await supabase.from('users').insert({ phone, agent_name: 'Saraya' }).select().single();
    user = newUser;
  }
  return user;
}

function isPasswordRelated(msg) {
  const lower = msg.toLowerCase();
  return lower.includes('password') || lower.includes('pass ') || lower.includes('login') || lower.includes('credential') || lower.includes('secret');
}

async function askClaude(userMessage, memories, agentName) {
  const memoryText = memories.length > 0
    ? memories.map((m, i) => `${i + 1}. [${m.category}] ${m.content}`).join('\n')
    : 'Abhi koi memory saved nahi hai.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: `Tu ${agentName} hai — ek personal AI memory assistant. Hinglish mein baat kar.

User ki saved memories:
${memoryText}

Rules:
- Save karna ho → SAVE:[category]:[content] format use kar
- Reminder → REMINDER:[datetime]:[message] format use kar
- Kuch poochha ho → memory se dhundh ke answer de
- Short aur friendly reh

Example save:
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
      await supabase.from('memories').insert({ user_id: userId, category, content, is_encrypted: false });
    } else if (line.startsWith('REMINDER:')) {
      const parts = line.replace('REMINDER:', '').split(':');
      const dateStr = parts[0].trim();
      const message = parts.slice(1).join(':').trim();
      let remindAt = new Date();
      if (dateStr.toLowerCase().includes('tomorrow') || dateStr.toLowerCase().includes('kal')) {
        remindAt.setDate(remindAt.getDate() + 1);
      }
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

app.post('/webhook', async (req, res) => {
  res.status(200).send('');
  const incomingMsg = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:', '');
  if (!from || !incomingMsg) return;

  try {
    const user = await getOrCreateUser(from);
    const agentName = user.agent_name || 'Saraya';
    const lower = incomingMsg.toLowerCase();

    // WELCOME
    if (lower === 'hi' || lower === 'hello' || lower === 'start' || lower === 'hii') {
      await sendMessage(from,
        `🌟 *Welcome!* Main hun ${agentName} — tumhara personal AI memory assistant!\n\n` +
        `📞 Contacts\n📝 Notes\n🔒 Passwords\n⏰ Reminders\n\n` +
        `Pehle mujhe naam do!\nType karo: *"Mujhe [naam] bulao"*`
      );
      return;
    }

    // SET NAME
    if (lower.startsWith('mujhe') && lower.includes('bulao')) {
      const nameMatch = incomingMsg.match(/mujhe\s+(\w+)\s+bulao/i);
      if (nameMatch) {
        await supabase.from('users').update({ agent_name: nameMatch[1] }).eq('id', user.id);
        await sendMessage(from, `✨ Ab main hun *${nameMatch[1]}*! Kya yaad rakhun? 😊`);
        return;
      }
    }

    // SET PIN
    if (lower.includes('pin set') || lower.includes('set pin')) {
      const pinMatch = incomingMsg.match(/\d{4,6}/);
      if (pinMatch) {
        const hashedPin = await bcrypt.hash(pinMatch[0], 10);
        await supabase.from('users').update({ pin: hashedPin }).eq('id', user.id);
        await sendMessage(from, `🔒 *PIN set ho gaya!*\n\nAb passwords safe rahenge. Test karo!`);
      } else {
        await sendMessage(from, `PIN 4-6 digits ka hona chahiye.\nExample: "PIN set karo 1234"`);
      }
      return;
    }

    // PIN VERIFICATION
    if (pinSessions[from]) {
      const session = pinSessions[from];
      const pinMatch = incomingMsg.match(/^\d{4,6}$/);
      if (!pinMatch) {
        await sendMessage(from, `❌ Sirf numbers bhejo (4-6 digits):`);
        return;
      }
      if (!user.pin) {
        delete pinSessions[from];
        await sendMessage(from, `PIN set nahi hai! Type karo: "PIN set karo 1234"`);
        return;
      }
      const isValid = await bcrypt.compare(incomingMsg, user.pin);
      if (!isValid) {
        await sendMessage(from, `❌ *Galat PIN!* Dobara try karo:`);
        return;
      }

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
          const list = passwords.map((p, i) => `${i + 1}. 🔑 ${p.content}`).join('\n');
          await sendMessage(from, `✅ *PIN correct!*\n\n*Tumhare passwords:*\n\n${list}`);
        }
        return;
      }
    }

    // PASSWORD SAVE
    if (isPasswordRelated(incomingMsg) && (lower.includes('save') || lower.includes('add') || lower.includes('store'))) {
      if (!user.pin) {
        await sendMessage(from, `🔒 Pehle PIN set karo:\n*"PIN set karo 1234"*`);
        return;
      }
      pinSessions[from] = { action: 'save_password', data: incomingMsg };
      await sendMessage(from, `🔒 *Security Check!*\n\nApna PIN bhejo:`);
      return;
    }

    // PASSWORD VIEW
    if (isPasswordRelated(incomingMsg)) {
      if (!user.pin) {
        await sendMessage(from, `🔒 Pehle PIN set karo:\n*"PIN set karo 1234"*`);
        return;
      }
      pinSessions[from] = { action: 'view_password', data: incomingMsg };
      await sendMessage(from, `🔒 *Security Check!*\n\nApna PIN bhejo:`);
      return;
    }

    // GENERAL — Claude
    const { data: memories } = await supabase.from('memories').select('*').eq('user_id', user.id).eq('is_encrypted', false).neq('category', 'password').order('created_at', { ascending: false }).limit(50);
    const claudeReply = await askClaude(incomingMsg, memories || [], agentName);
    const finalReply = await processClaudeResponse(claudeReply, user.id);
    await sendMessage(from, finalReply);

  } catch (err) {
    console.error('Error:', err.message);
    try { await sendMessage(from, '😅 Kuch issue aaya. Thodi der baad try karo!'); } catch (e) {}
  }
});

// REMINDERS
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const { data: dueReminders } = await supabase.from('reminders').select('*, users(phone, agent_name)').eq('is_sent', false).lte('remind_at', now.toISOString());
  for (const reminder of (dueReminders || [])) {
    try {
      await sendMessage(reminder.users.phone, `⏰ *Reminder!*\n\n📌 ${reminder.message}`);
      await supabase.from('reminders').update({ is_sent: true }).eq('id', reminder.id);
    } catch (e) { console.error('Reminder error:', e.message); }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Saraya bot chal raha hai — Port ${PORT}`);
});