// ACP form elicitation ⇄ chat text. Pure logic → unit-testable.
//
// The claude adapter turns the agent's AskUserQuestion tool into an ACP
// `elicitation/create` request (mode "form"): fields keyed `question_<n>`
// (string+oneOf for single-select, array+items.anyOf for multi-select), each
// followed by an optional `question_<n>_custom` free-text field ("Other").
// Option `const` is the clean label; `title` is "label — description".
//
// We render that form as a numbered question card for the room / IM chat, and
// parse a human's one-line reply back into the response content. Answers that
// match no option flow into the field's `_custom` slot instead of failing —
// mirroring the CLI's "Other" box. Nothing is required, so `skip` is a valid
// answer (accept with empty content).

// requestedSchema → ordered fields, folding `<key>_custom` into its base field.
export function parseForm(params) {
  const props = params?.requestedSchema?.properties || {};
  const fields = [];
  const byKey = new Map();
  for (const [key, p] of Object.entries(props)) {
    const base = key.endsWith('_custom') ? key.slice(0, -'_custom'.length) : null;
    if (base && byKey.has(base)) { byKey.get(base).customKey = key; continue; }
    const multi = p?.type === 'array';
    const raw = multi ? (p?.items?.anyOf || []) : (p?.oneOf || []);
    const options = raw.map((o) => ({ label: o.const, title: o.title || o.const }));
    const f = { key, customKey: null, title: p?.title || null, description: p?.description || null, multi, options };
    byKey.set(key, f);
    fields.push(f);
  }
  return { message: params?.message || '', fields };
}

// One question card. Single question keeps it flat; multiple questions number themselves.
export function renderQuestion(form) {
  const lines = [`❓ ${form.message}`];
  const many = form.fields.length > 1;
  form.fields.forEach((f, i) => {
    const head = [f.title, f.description].filter(Boolean).join(' — ');
    if (many) lines.push(`${i + 1}) ${head || `问题 ${i + 1}`}`);
    else if (head) lines.push(head);
    f.options.forEach((o, j) => lines.push(`  ${j + 1}. ${o.title}`));
  });
  const hints = ['回复编号作答'];
  if (form.fields.some((f) => f.multi)) hints.push('多选用逗号(如 1,3)');
  if (many) hints.push('多个问题按顺序用分号分隔(如 2; 1,3)');
  hints.push('选项之外可直接打字', '回复 skip 跳过');
  lines.push(`(${hints.join(';')})`);
  return lines.join('\n');
}

// Resolve one field's answer text → content entries. Numbers / exact labels hit
// the option enum; anything else lands in the field's custom free-text slot.
function answerField(f, text, content) {
  const t = (text || '').trim();
  if (!t) return;
  const pick = (tok) => {
    const n = parseInt(tok, 10);
    if (Number.isInteger(n) && n >= 1 && n <= f.options.length && String(n) === tok.trim()) return f.options[n - 1].label;
    const hit = f.options.find((o) => String(o.label).toLowerCase() === tok.trim().toLowerCase());
    return hit ? hit.label : null;
  };
  if (f.multi) {
    const toks = t.split(/[,,、]/).map((s) => s.trim()).filter(Boolean);
    const picked = toks.map(pick);
    if (toks.length && picked.every((x) => x !== null)) { content[f.key] = picked; return; }
  } else {
    const one = pick(t);
    if (one !== null) { content[f.key] = one; return; }
  }
  if (f.customKey) content[f.customKey] = t;      // free text → the "Other" box
  else content[f.key] = f.multi ? [t] : t;        // no custom slot → best effort
}

// One reply line → CreateElicitationResponse. Never rejects a human: unmatched
// text becomes a custom answer; only an empty reply asks again.
export function parseReply(form, reply) {
  const t = (reply || '').trim();
  if (!t) return { ok: false, hint: '(空回复)请回编号或文字作答,或回 skip 跳过。' };
  if (/^(skip|跳过|不用|pass)$/i.test(t)) return { ok: true, response: { action: 'accept', content: {} } };
  if (/^(cancel|取消)$/i.test(t)) return { ok: true, response: { action: 'cancel' } };
  const content = {};
  if (form.fields.length > 1) {
    const parts = t.split(/[;;\n]/);
    form.fields.forEach((f, i) => answerField(f, parts[i], content));
  } else if (form.fields.length === 1) {
    answerField(form.fields[0], t, content);
  }
  return { ok: true, response: { action: 'accept', content } };
}
