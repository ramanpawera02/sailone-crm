// Turn free-form spoken text into structured CRM fields, for several entity types.
//   * If ANTHROPIC_API_KEY is set -> uses Claude (best accuracy).
//   * Otherwise                   -> a simple built-in extractor (email/phone/dates).
//
// parseEntity(kind, transcript, ctx) where kind is 'lead' | 'contact' |
// 'opportunity' | 'reminder', and ctx may include { now } (the client's local time,
// used to resolve "next Tuesday" style phrases for reminders).

const SPECS = {
  lead: {
    keys: ['name', 'company', 'email', 'phone', 'source', 'notes'],
    guide:
      'name = the person\'s full name. company = their organization. ' +
      'source = how the lead was found (e.g. "conference", "referral", "website") if mentioned. ' +
      'notes = any other useful context such as needs, deal size, timing, or next steps.',
  },
  contact: {
    keys: ['name', 'company', 'email', 'phone', 'title', 'notes'],
    guide:
      'name = the person\'s full name. company = their organization. ' +
      'title = their job title if mentioned. notes = any other useful context.',
  },
  opportunity: {
    keys: ['title', 'value', 'stage', 'close_date', 'contact_name', 'notes'],
    guide:
      'title = a short name for the deal. value = the deal amount as digits only, no currency symbol. ' +
      'stage = one of prospecting, proposal, negotiation, won, lost (choose the closest; default prospecting). ' +
      'close_date = expected close date as YYYY-MM-DD if mentioned. ' +
      'contact_name = the person/company this deal is with, if named. notes = other context.',
  },
  reminder: {
    keys: ['channel', 'title', 'body', 'due_at', 'contact_name'],
    guide:
      'channel = "push" for a reminder to myself (the salesperson) to call/email someone, ' +
      'or "email" only if I clearly mean to send the customer an email. Default "push". ' +
      'title = short summary (e.g. "Call Jane about pricing"). body = any extra detail. ' +
      'contact_name = the person the reminder is about, if named. ' +
      'due_at = the absolute date/time formatted EXACTLY as YYYY-MM-DD HH:MM:SS. ' +
      'Resolve relative phrases like "tomorrow", "next Tuesday at 10am", "in 2 hours" using the ' +
      'current date/time given below. If no time is given, use 09:00:00.',
  },
};

function emptyFor(kind) {
  const o = {};
  for (const k of SPECS[kind].keys) o[k] = '';
  return o;
}

async function parseEntity(kind, transcript, ctx = {}) {
  const spec = SPECS[kind];
  if (!spec) throw new Error('unknown parse kind: ' + kind);
  const text = (transcript || '').trim();
  if (!text) return emptyFor(kind);

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      return await parseWithClaude(kind, text, key, ctx);
    } catch (e) {
      console.error(`Claude parse(${kind}) failed, using fallback:`, e.message);
    }
  }
  return fallback(kind, text, ctx);
}

async function parseWithClaude(kind, text, key, ctx) {
  const spec = SPECS[kind];
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const nowLine =
    kind === 'reminder'
      ? ` The current date and time is ${ctx.now || new Date().toISOString()}.`
      : '';
  const system =
    `You extract CRM ${kind} details from a salesperson speaking naturally. ` +
    `Respond with ONLY a JSON object, no prose, no code fences, with exactly these keys: ` +
    `${spec.keys.join(', ')}. ${spec.guide} ` +
    `Use an empty string for anything not mentioned. Do not invent values.` +
    nowLine;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = (data.content || []).map((c) => c.text || '').join('').trim();
  const json = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(json);

  const out = emptyFor(kind);
  for (const k of spec.keys) if (typeof parsed[k] === 'string') out[k] = parsed[k].trim();
  return out;
}

// ---- No-API fallback: best-effort regex/heuristics ----
function fallback(kind, text, ctx) {
  const out = emptyFor(kind);
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phone = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  const name = text.match(/(?:lead|contact|name is|this is|called|add|for|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  const company = text.match(/(?:from|at|with)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)?)/);
  const money = text.match(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?/i);

  if (kind === 'lead' || kind === 'contact') {
    if (name) out.name = name[1];
    if (company) out.company = company[1];
    if (email) out.email = email[0];
    if (phone) out.phone = phone[0].trim();
    out.notes = text;
  } else if (kind === 'opportunity') {
    out.title = name ? `${name[1]} opportunity` : 'New opportunity';
    if (money) {
      let v = parseFloat(money[1].replace(/,/g, ''));
      const unit = (money[2] || '').toLowerCase();
      if (unit.startsWith('k') || unit === 'thousand') v *= 1000;
      if (unit.startsWith('m') || unit === 'million') v *= 1000000;
      out.value = String(v);
    }
    out.stage = 'prospecting';
    if (name) out.contact_name = name[1];
    out.notes = text;
  } else if (kind === 'reminder') {
    out.channel = 'push';
    out.title = text.slice(0, 80);
    out.body = text;
    if (name) out.contact_name = name[1];
    out.due_at = ''; // can't reliably parse dates without the API; user picks the time
  }
  return out;
}

// keep the original name working
const parseLead = (t, ctx) => parseEntity('lead', t, ctx);

module.exports = { parseEntity, parseLead };
