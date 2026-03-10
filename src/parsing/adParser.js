const CATEGORY_RULES = [
  { name: 'Авто', keywords: ['авто', 'машин', 'автомоб', 'toyota', 'bmw', 'mercedes', 'lada', 'kia', 'hyundai', 'пробег', 'двигател', 'акпп', 'мкпп', 'vin'] },
  { name: 'Недвижимость', keywords: ['квартир', 'дом', 'комнат', 'аренда', 'сдам', 'сдается', 'недвижим', 'офис', 'посуточно', 'ипотек'] },
  { name: 'Электроника', keywords: ['iphone', 'samsung', 'xiaomi', 'телефон', 'смартфон', 'ноутбук', 'macbook', 'пк', 'playstation', 'ps5', 'ipad', 'наушник'] },
  { name: 'Работа', keywords: ['ваканси', 'работ', 'зарплат', 'требуетс', 'график', 'сотрудник', 'резюме'] },
  { name: 'Услуги', keywords: ['услуг', 'ремонт', 'мастер', 'доставка', 'перевоз', 'маникюр', 'парикмахер', 'сантехник', 'электрик'] },
  { name: 'Одежда', keywords: ['куртка', 'платье', 'кроссовк', 'обув', 'одежд', 'размер', 'брюки', 'футболк'] },
  { name: 'Дом и сад', keywords: ['диван', 'кровать', 'шкаф', 'стол', 'мебел', 'холодильник', 'стирал', 'посуда', 'сад'] },
  { name: 'Детские товары', keywords: ['детск', 'коляска', 'игрушк', 'подгуз', 'школ', 'самокат'] },
  { name: 'Животные', keywords: ['кот', 'кошка', 'собак', 'щенок', 'питом', 'ветеринар', 'корм'] },
  { name: 'Спорт и хобби', keywords: ['велосипед', 'спорт', 'гантел', 'рыбалк', 'охота', 'музык', 'гитара'] },
];

export function looksLikeAd(text, adKeywords) {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const hasAdKeyword = adKeywords.some((kw) => normalized.includes(kw));
  const hasPrice = extractPrice(normalized) !== null;
  const contacts = extractContacts(normalized);
  const hasContacts = Boolean(contacts.contactPhone || contacts.contactUsername || contacts.contactText);
  const hasSellingVerb = /(продам|продаю|куплю|сдам|ищу|обмен|торг|ваканси|работа|услуг)/i.test(normalized);

  let score = 0;
  if (hasAdKeyword) score += 2;
  if (hasPrice) score += 2;
  if (hasContacts) score += 1;
  if (hasSellingVerb) score += 1;

  return score >= 2;
}

export function extractStructuredData(text) {
  const cleanText = normalizeText(text);
  const lines = splitLines(cleanText);
  const title = pickTitle(lines);
  const description = buildDescription(cleanText, title);
  const price = extractPrice(cleanText);
  const contacts = extractContacts(cleanText);
  const category = detectCategory(`${title || ''}\n${description || ''}`);

  return {
    title: title || null,
    description: description || null,
    priceValue: price,
    contactPhone: contacts.contactPhone,
    contactUsername: contacts.contactUsername,
    contactText: contacts.contactText,
    category: category || null,
  };
}

function normalizeText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').trim();
}

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isMetaLine(line) {
  return /^(#?\s*(актуально|срочно|up|ап|подниму|вверх)(?:\s|$|[!?.])|[#@!?.\s]+)$/i.test(line);
}

function isServiceLine(line) {
  return /(цена|стоимость|телефон|звоните|писать|ватсап|whatsapp|telegram|tg|контакт)/i.test(line);
}

function titleScore(line) {
  if (!line) return -100;
  if (isMetaLine(line)) return -50;
  let score = 0;
  const plain = line.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const len = plain.length;
  if (len >= 6 && len <= 90) score += 3;
  if (!isServiceLine(line)) score += 2;
  if (/(продам|куплю|сдам|iphone|samsung|toyota|bmw|nissan|квартир|дом|ноутбук|телефон)/i.test(line)) score += 2;
  if (/^\d/.test(line)) score -= 2;
  if (line.split(/\s+/).length >= 2) score += 1;
  return score;
}

function pickTitle(lines) {
  if (lines.length === 0) return '';
  const best = [...lines]
    .map((line) => ({ line, score: titleScore(line) }))
    .sort((a, b) => b.score - a.score)[0];
  return String(best?.line || lines[0]).slice(0, 140);
}

function buildDescription(cleanText, title) {
  if (!cleanText) return null;
  const lines = splitLines(cleanText);
  const titleIndex = lines.findIndex((line) => line === title);
  const filtered = lines.filter((line, idx) => !(idx === titleIndex));
  const result = filtered.join('\n').trim();
  return (result || cleanText).slice(0, 4000);
}

function extractPrice(text) {
  if (!text) return null;
  const raw = String(text).toLowerCase();
  const candidates = [];

  const lineCandidates = raw.split('\n');
  for (const line of lineCandidates) {
    const hasPriceHint = /(цена|стоимость|продаю\s+за|за\s+\d|отдам|всего|итог|руб|₽|тыс|т(?![a-zа-я])|k(?![a-z])|к(?![a-zа-я]))/i.test(line);
    if (!hasPriceHint) continue;
    const value = parsePriceFromFragment(line);
    if (value !== null) candidates.push({ value, weight: 3 });
  }

  const valueWithCurrency = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{2,9})\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|m(?![a-z]))/gi;
  let match;
  while ((match = valueWithCurrency.exec(raw)) !== null) {
    const value = parseNumericPrice(match[1], match[2]);
    if (value !== null) candidates.push({ value, weight: 2 });
  }

  if (candidates.length === 0) return null;

  // Выбираем наибольший вес, при равенстве — более правдоподобную рыночную цену.
  candidates.sort((a, b) => b.weight - a.weight || b.value - a.value);
  return candidates[0].value;
}

function parsePriceFromFragment(fragment) {
  const pricePattern = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{2,9})(?:\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|m(?![a-z])))?/i;
  const match = String(fragment).match(pricePattern);
  if (!match) return null;
  return parseNumericPrice(match[1], match[2] || '');
}

function parseNumericPrice(rawNumber, rawSuffix) {
  const digits = String(rawNumber || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  let value = Number(digits);
  if (!Number.isFinite(value)) return null;

  const suffix = String(rawSuffix || '').toLowerCase().replace(/[^a-zа-яё₽]/gi, '');
  if (['т', 'тыс', 'k', 'к'].includes(suffix)) value *= 1000;
  if (['млн', 'm'].includes(suffix)) value *= 1000000;

  if (value < 100) return null;
  if (value > 1000000000) return null;
  return Math.round(value);
}

function extractContacts(text) {
  const normalized = String(text || '');

  const phoneMatches = normalized.match(/(?:\+?\d[\d\s\-()]{8,}\d)/g) || [];
  const phones = phoneMatches
    .map((phone) => normalizePhone(phone))
    .filter(Boolean);
  const uniquePhones = [...new Set(phones)];

  const tgAtMatches = normalized.match(/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g) || [];
  const tgLinkMatches = normalized.match(/https?:\/\/t\.me\/([a-zA-Z0-9_]{4,32})/gi) || [];
  const usernames = [
    ...tgAtMatches.map((entry) => entry.trim().replace(/^@/, '')),
    ...tgLinkMatches
      .map((entry) => entry.match(/t\.me\/([a-zA-Z0-9_]{4,32})/i)?.[1] || '')
      .filter(Boolean),
  ].filter(Boolean);
  const uniqueUsernames = [...new Set(usernames)];

  const contactParts = [
    ...uniquePhones.map((phone) => `phone:${phone}`),
    ...uniqueUsernames.map((username) => `tg:@${username}`),
  ];

  return {
    contactPhone: uniquePhones.length > 0 ? uniquePhones.join(',') : null,
    contactUsername: uniqueUsernames.length > 0 ? uniqueUsernames.join(',') : null,
    contactText: contactParts.length > 0 ? contactParts.join('; ') : null,
  };
}

function normalizePhone(value) {
  const cleaned = String(value || '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+') && cleaned.length >= 11 && cleaned.length <= 16) return cleaned;
  if (!cleaned.startsWith('+') && cleaned.length >= 10 && cleaned.length <= 15) return `+${cleaned}`;
  return null;
}

function detectCategory(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return 'Разное';

  let bestCategory = 'Разное';
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (normalized.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.name;
    }
  }

  return bestCategory;
}
