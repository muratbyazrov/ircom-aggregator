import { createHash } from 'node:crypto';

const MAX_TITLE_LENGTH = 60;

const CATEGORY_RULES = [
  { name: 'Авто', keywords: ['авто', 'машин', 'автомоб', 'toyota', 'bmw', 'mercedes', 'lada', 'kia', 'hyundai', 'ваз', 'пробег', 'двигател', 'акпп', 'мкпп', 'vin', 'л/с', 'мотор', 'привод', 'механика', 'бампер'] },
  { name: 'Недвижимость', keywords: ['квартир', 'дом', 'комнат', 'аренда', 'сдам', 'сдается', 'недвижим', 'офис', 'посуточно', 'ипотек', 'район', 'раен', 'участок', 'земля'] },
  { name: 'Электроника', keywords: ['iphone', 'айфон', 'samsung', 'xiaomi', 'телефон', 'смартфон', 'ноутбук', 'macbook', 'пк', 'playstation', 'ps5', 'ipad', 'наушник', 'xbox', 'x box'] },
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

export function buildContentHash(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const canonical = normalized
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!canonical) return null;
  return createHash('sha1').update(canonical, 'utf8').digest('hex');
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
  if (normalizePhone(plain) || /^(?:\+?\d[\d\s\-()]{8,}\d)$/.test(line.trim())) score -= 12;
  const len = plain.length;
  if (len >= 6 && len <= 70) score += 3;
  else if (len > 70 && len <= 100) score += 1;
  if (!isServiceLine(line)) score += 2;
  if (/(продам|куплю|сдам|iphone|samsung|toyota|bmw|nissan|квартир|дом|ноутбук|телефон)/i.test(line)) score += 2;
  if (/^\d/.test(line)) score -= 2;
  if (/^(продаю|продам|срочно|продаётся|продается)\s*$/i.test(plain)) score -= 3;
  if (/^(продаю|продам|срочно|продаётся|продается)\b/i.test(plain) && plain.length < 18) score -= 2;
  if (line.split(/\s+/).length >= 2) score += 1;
  return score;
}

function pickTitle(lines) {
  if (lines.length === 0) return '';
  const scored = [...lines]
    .map((line) => ({ line, score: titleScore(line) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const isGeneric = /^(продаю|продам|срочно|продаётся|продается)\b/i.test(String(best?.line || ''));
  const selected = isGeneric && scored[1] && scored[1].score >= best.score - 1 ? scored[1].line : best?.line;
  const fallbackSelected = String(selected || lines[0]).trim();
  if (fallbackSelected.length >= 5 && fallbackSelected.split(/\s+/).length >= 2) {
    return finalizeTitle(fallbackSelected);
  }

  const joined = lines
    .filter((line) => !normalizePhone(line))
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return finalizeTitle(joined || fallbackSelected);
}

function finalizeTitle(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= MAX_TITLE_LENGTH) return raw;

  const sentenceEnd = raw.slice(0, MAX_TITLE_LENGTH + 1).search(/[.!?;:](?:\s|$)/);
  if (sentenceEnd > 10 && sentenceEnd <= MAX_TITLE_LENGTH) {
    return raw.slice(0, sentenceEnd + 1).trim();
  }

  const cut = raw.slice(0, MAX_TITLE_LENGTH + 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= 24) {
    return cut.slice(0, lastSpace).trim();
  }

  return raw.slice(0, MAX_TITLE_LENGTH).trim();
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
  const rawWithoutPhones = stripPhoneLikeNumbers(raw);
  const candidates = [];

  const lineCandidates = rawWithoutPhones.split('\n');
  for (const line of lineCandidates) {
    const hasPriceHint = /(цена|стоимость|продаю\s+за|за\s+\d|отдам|всего|итог|руб|₽|тыс|тысяч)/i.test(line);
    if (!hasPriceHint) continue;
    for (const item of parsePriceCandidatesFromFragment(line)) {
      candidates.push({ value: item.value, weight: item.weight + 3 });
    }
  }

  const valueWithCurrency = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{2,9})\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|m(?![a-z]))/gi;
  let match;
  while ((match = valueWithCurrency.exec(rawWithoutPhones)) !== null) {
    const value = parseNumericPrice(match[1], match[2]);
    if (value !== null) candidates.push({ value, weight: 4 });
  }

  // Fallback: ищем голые числа в линиях с ценовыми маркерами (например "цена 48 торг"),
  // если формат "тыс/т" не указан, но значение выглядит как "тысячи рублей".
  const barePriceCandidates = rawWithoutPhones
    .split('\n')
    .filter((line) => /(цена|стоимость|за\s+\d|отдам|торг)/i.test(line))
    .flatMap((line) => parsePriceCandidatesFromFragment(line, true));
  for (const item of barePriceCandidates) {
    candidates.push({ value: item.value, weight: item.weight + 2 });
  }

  if (candidates.length === 0) return null;

  // Выбираем наибольший вес, при равенстве — более правдоподобную рыночную цену.
  candidates.sort((a, b) => b.weight - a.weight || b.value - a.value);
  return candidates[0].value;
}

function parsePriceCandidatesFromFragment(fragment, allowBareNumber = false) {
  const result = [];
  const re = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{2,9})(?:\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|m(?![a-z])))?/gi;
  let match;
  while ((match = re.exec(String(fragment))) !== null) {
    const hasSuffix = Boolean(match[2]);
    if (!hasSuffix) {
      if (!allowBareNumber) continue;
      const bareDigits = String(match[1] || '').replace(/[^\d]/g, '');
      if (!bareDigits) continue;
      const bareValue = Number(bareDigits);
      if (!Number.isFinite(bareValue)) continue;
      const matchIndex = match.index || 0;
      const before = String(fragment).slice(Math.max(0, matchIndex - 18), matchIndex);
      const nearPriceKeyword = /(цена|стоим|за|отдам|всего|итог|торг)/i.test(before);
      if (!nearPriceKeyword) continue;
      if (bareValue >= 20 && bareValue <= 900) {
        // В локальных объявлениях "цена 48" обычно значит 48 000.
        result.push({ value: bareValue * 1000, weight: 2 });
      } else if (bareValue >= 1000 && bareValue <= 1000000) {
        result.push({ value: bareValue, weight: 1 });
      }
      continue;
    }

    const value = parseNumericPrice(match[1], match[2] || '');
    if (value === null) continue;
    result.push({ value, weight: 3 });
  }
  return result;
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

function stripPhoneLikeNumbers(text) {
  return String(text || '').replace(/(?:\+?\d[\d\s\-()]{8,}\d)/g, ' ');
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

  const autoHeuristic =
    /(19\d{2}|20\d{2})\s*г/.test(normalized) &&
    /(объем|двигател|механика|акпп|мкпп|л\/с|привод|пробег|газ)/.test(normalized);
  if (autoHeuristic) {
    return 'Авто';
  }

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
