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

// ── CLIENTS ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── PIN SESSIONS (temporary in-memory) ───────────────────────────
const pinSessions = {};

// ── SEND WHATSAPP MESSAGE ─────────────────────────────────────────
async function sendMessage(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${to}`,
    body
  });
}

// ── GET OR CREATE USER ────────────────────────────────────────────
async function getOrCreateUser(phone) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single();

  if (!user) {
    const { data: newUser } = await supabase
      .from('users')
      .insert({ phone, agent_name: 'Saraya' })
      .select()
      .single();
    user = newUser;
  }
  return user;
}

// ── CLAUDE AI BRAIN ───────────────────────────────────────────────
async function askClaude(userMessage, memories, agentName) {
  const memoryText = memories.length > 0
    ? memories.map((m, i) => `${i + 1}. [${m.category}] ${m.content}`).join('\n')
    : 'Abhi koi memory saved nahi hai.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: `Tu ${agentName} hai — ek personal AI memory assistant jo WhatsApp pe kaam karta hai.

Teri duties:
1. User ki information save karna
2. Saved information retrieve karna  
3. Reminders set karna
4. Natural Hinglish mein baat karna (Hindi + English mix)

User ki current memories:
${memoryText}

Response rules:
- Agar user kuch save karna chahta hai → "SAVE: [category]: [content]" format mein respond kar
- Agar user kuch pooch raha hai → memory se dhundh ke answer de
- Agar user reminder set karna chahta hai → "REMINDER: [datetime]: [message]" format mein respond kar
- Agar password related hai → "PIN_REQUIRED" bol
- Friendly, short aur helpful reh
- Categories: contact, password, note, task, idea, expense, general

Examples:
User: "Rahul ka number 9876500000 save karo, wo CA hai"
Response: "SAVE: contact: Rahul (CA) — 9876500000\n✅ Saved! Rahul CA ka number yaad aa gaya mujhe."

User: "Kal 9 baje doctor appointment yaad dilana"
Response: "REMINDER: tomorrow 9:00 AM: Doctor appointment\n⏰ Done! Kal 9 baje remind karunga."

User: "Rahul ka number kya tha?"
Response: "Rahul (CA) ka number hai — 9876500000 📞"`,
    messages: [{ role: 'user', content: userMessage }]
  });

  return response.content[0].text;
}

// ── PROCESS CLAUDE RESPONSE ───────────────────────────────────────
async function processResponse(claudeReply, userId, phone, agentName) {
  const lines = claudeReply.split('\n');
  let finalReply = claudeReply;
  let savedSomething = false;

  for (const line of lines) {
    // Save memory
    if (line.startsWith('SAVE:')) {
      const parts = line.replace('SAVE:', '').trim().split(':');
      const category = parts[0].trim().toLowerCase();
      const content = parts.slice(1).join(':').trim();

      await supabase.from('memories').insert({
        user_id: userId,
        category,
        content,
        is_encrypted: false
      });
      savedSomething = true;
    }

    // Set reminder
    if (line.startsWith('REMINDER:')) {
      const parts = line.replace('REMINDER:', '').trim().split(':');
      const dateStr = parts[0].trim();
      const message = parts.slice(1).join(':').trim();

      // Parse date
      let remindAt = new Date();
      if (dateStr.toLowerCase().includes('tomorrow')) {
        remindAt.setDate(remindAt.getDate() + 1);
        const timePart = dateStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
        if (timePart) {
          let hours = parseInt(timePart[1]);
          const minutes = parseInt(timePart[2]);
          const ampm = timePart[3];
          if (ampm && ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
          remindAt.setHours(hours, minutes, 0, 0);
        }
      } else {
        const timePart = dateStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
        if (timePart) {
          let hours = parseInt(timePart[1]);
          const minutes = parseInt(timePart[2]);
          const ampm = timePart[3];
          if (ampm && ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
          remindAt.setHours(hours, minutes, 0, 0);
        }
      }

      await supabase.from('reminders').insert({
        user_id: userId,
        message,
        remind_at: remindAt.toISOString(),
        is_sent: false
      });
    }

    // PIN required for passwords
    if (line.includes('PIN_REQUIRED')) {
      pinSessions[phone] = { waiting: true, query: '' };
      finalReply = `🔒 Ye sensitive information hai.\n\nSecurity ke liye apna PIN bhejo pehle.\n\n(PIN nahi set kiya? "PIN set karo 1234" type karo)`;
    }
  }

  // Clean up response — remove command lines
  finalReply = claudeReply
    .split('\n')
    .filter(l => !l.startsWith('SAVE:') && !l.startsWith('REMINDER:') && !l.includes('PIN_REQUIRED'))
    .join('\n')
    .trim();

  return finalReply || '✅ Done!';
}

// ── MAIN WEBHOOK ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('');

  const incomingMsg = req.body.Body?.trim() || '';
  const from = req.body.From?.replace('whatsapp:', '') || '';

  if (!from || !incomingMsg) return;

  try {
    const user = await getOrCreateUser(from);
    const agentName = user.agent_name || 'Saraya';

    // ── NEW USER WELCOME ──
    if (!user.pin && !user.agent_name_set) {
      const isFirstMessage = incomingMsg.toLowerCase().includes('hi') ||
        incomingMsg.toLowerCase().includes('hello') ||
        incomingMsg.toLowerCase().includes('start');

      if (isFirstMessage) {
        await sendMessage(from,
          `🌟 *Welcome!* Main hun ${agentName} — tumhara personal AI memory assistant!\n\n` +
          `Main tumhari sari important cheezein yaad rakhunga:\n` +
          `📞 Contacts\n📝 Notes & Ideas\n🔒 Passwords\n⏰ Reminders\n\n` +
          `*Pehle mujhe apna naam do!*\nType karo: *"Mera naam [tumhara naam] hai"*`
        );
        return;
      }
    }

    // ── SET AGENT NAME ──
    if (incomingMsg.toLowerCase().startsWith('mujhe') && incomingMsg.toLowerCase().includes('naam')) {
      const nameMatch = incomingMsg.match(/naam\s+(\w+)\s+rakhna|naam\s+(\w+)\s+do|naam\s+(\w+)\s+hai/i);
      if (nameMatch) {
        const newName = nameMatch[1] || nameMatch[2] || nameMatch[3];
        await supabase.from('users').update({ agent_name: newName }).eq('id', user.id);
        await sendMessage(from,
          `✨ Perfect! Ab main hun *${newName}* — sirf tumhara personal assistant!\n\n` +
          `Ab bolo, kya yaad rakhun tumhare liye? 😊\n\n` +
          `*Examples:*\n` +
          `• "Rahul ka number 9876500000 save karo"\n` +
          `• "Kal 3 baje meeting yaad dilana"\n` +
          `• "Netflix password save karo"`
        );
        return;
      }
    }

    // ── SET PIN ──
    if (incomingMsg.toLowerCase().startsWith('pin set karo') || incomingMsg.toLowerCase().startsWith('pin set')) {
      const pinMatch = incomingMsg.match(/\d{4,6}/);
      if (pinMatch) {
        const hashedPin = await bcrypt.hash(pinMatch[0], 10);
        await supabase.from('users').update({ pin: hashedPin }).eq('id', user.id);
        await sendMessage(from, `🔒 PIN set ho gaya! Ab tumhari passwords safe rahenge.\n\nTest karo — koi password save karo!`);
        return;
      }
    }

    // ── PIN VERIFICATION ──
    if (pinSessions[from] && pinSessions[from].waiting) {
      const pinMatch = incomingMsg.match(/^\d{4,6}$/);
      if (pinMatch && user.pin) {
        const isValid = await bcrypt.compare(incomingMsg, user.pin);
        if (isValid) {
          pinSessions[from] = null;
          // Get encrypted memories
          const { data: passwords } = await supabase
            .from('memories')
            .select('*')
            .eq('user_id', user.id)
            .eq('category', 'password');

          if (passwords?.length > 0) {
            const list = passwords.map(p => `🔑 ${p.content}`).join('\n');
            await sendMessage(from, `✅ PIN correct!\n\n*Tumhare passwords:*\n${list}`);
          } else {
            await sendMessage(from, `✅ PIN correct! Abhi koi password saved nahi hai.\n\n"Netflix password: MyPass123 save karo" type karo!`);
          }
        } else {
          await sendMessage(from, `❌ Galat PIN! Dobara try karo.`);
        }
        return;
      }
    }

    // ── GET ALL MEMORIES ──
    const { data: memories } = await supabase
      .from('memories')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_encrypted', false)
      .order('created_at', { ascending: false })
      .limit(50);

    // ── ASK CLAUDE ──
    const claudeReply = await askClaude(incomingMsg, memories || [], agentName);

    // ── PROCESS & SEND ──
    const finalReply = await processResponse(claudeReply, user.id, from, agentName);
    await sendMessage(from, finalReply);

  } catch (err) {
    console.error('Error:', err.message);
    try {
      await sendMessage(from, '😅 Kuch technical issue aaya. Thodi der baad try karo!');
    } catch (e) {}
  }
});

// ── REMINDER CRON JOB (every minute) ─────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const { data: dueReminders } = await supabase
    .from('reminders')
    .select('*, users(phone, agent_name)')
    .eq('is_sent', false)
    .lte('remind_at', now.toISOString());

  for (const reminder of (dueReminders || [])) {
    try {
      const agentName = reminder.users?.agent_name || 'Saraya';
      await sendMessage(
        reminder.users.phone,
        `⏰ *Reminder from ${agentName}!*\n\n${reminder.message}`
      );
      await supabase
        .from('reminders')
        .update({ is_sent: true })
        .eq('id', reminder.id);
    } catch (e) {
      console.error('Reminder error:', e.message);
    }
  }
});

// ── START SERVER ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Saraya bot chal raha hai — Port ${PORT}`);
  console.log(`🌐 Webhook URL: http://localhost:${PORT}/webhook`);
});