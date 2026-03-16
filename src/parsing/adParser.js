import { createHash } from 'node:crypto';

const MAX_TITLE_LENGTH = 60;
const PHONE_LIKE_RE = /(?<![\d,.])(?:\+?\d{10,15}|\+?\d{1,4}(?:[\s()-]+\d{1,4}){2,})(?![\d])/gu;

const CATEGORY_RULES = [
  { name: 'Авто', keywords: ['авто', 'машин', 'автомоб', 'toyota', 'bmw', 'mercedes', 'lada', 'kia', 'hyundai', 'ваз', 'пробег', 'двигател', 'акпп', 'мкпп', 'vin', 'л/с', 'мотор', 'привод', 'механика', 'бампер'] },
  { name: 'Недвижимость', keywords: ['квартир', 'дом', 'комнат', 'аренда', 'сдам', 'сдается', 'недвижим', 'офис', 'посуточно', 'ипотек', 'район', 'раен', 'участок', 'земля'] },
  { name: 'Электроника', keywords: ['iphone', 'айфон', 'samsung', 'xiaomi', 'телефон', 'смартфон', 'ноутбук', 'macbook', 'пк', 'playstation', 'ps5', 'ipad', 'наушник', 'xbox', 'x box'] },
  { name: 'Работа', keywords: ['ваканси', 'работ', 'зарплат', 'требуетс', 'график', 'сотрудник', 'резюме'] },
  { name: 'Для дома', keywords: ['диван', 'кровать', 'шкаф', 'стол', 'мебел', 'холодильник', 'стирал', 'посуда', 'сад'] },
  { name: 'Для детей', keywords: ['детск', 'коляска', 'игрушк', 'подгуз', 'школ', 'самокат'] },
  { name: 'Другое', keywords: ['услуг', 'ремонт', 'мастер', 'доставка', 'перевоз', 'маникюр', 'парикмахер', 'сантехник', 'электрик', 'куртка', 'платье', 'кроссовк', 'обув', 'одежд', 'размер', 'брюки', 'футболк', 'кот', 'кошка', 'собак', 'щенок', 'питом', 'ветеринар', 'корм', 'велосипед', 'спорт', 'гантел', 'рыбалк', 'охота', 'музык', 'гитара'] },
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
  const description = buildDescription(cleanText);
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

export function buildDuplicateFingerprint(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const canonical = normalized
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
    .replace(PHONE_LIKE_RE, ' ')
    .replace(/(?<![\p{L}\p{N}_])(?:цена|стоимость)\s*\d[\d.,\s]{0,24}(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/(?<![\p{L}\p{N}_])\d{1,3}(?:[.,]\d{1,3})?\s*(?:т|тыс|k|к|млн|мл|m)(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/(?<![\p{L}\p{N}_])\d{1,3}(?:[ .,\t]\d{3})+(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/(?<![\p{L}\p{N}_])\d{5,}(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/(?<![\p{L}\p{N}_])торг(?![\p{L}\p{N}_])/gu, ' ')
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
  const phoneLikeCount = (line.match(PHONE_LIKE_RE) || []).length;
  if (normalizePhone(plain) || /^(?:\+?\d[\d()\- ]{8,}\d)$/.test(line.trim())) score -= 12;
  if (phoneLikeCount >= 2) score -= 10;
  else if (phoneLikeCount === 1) score -= 5;
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
  const cleanedFallback = cleanupTitleCandidate(stripPhoneLikeChunks(fallbackSelected));
  const leadingJoined = cleanupTitleCandidate(
    stripPhoneLikeChunks(
      lines
        .slice(0, 3)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
  if (
    leadingJoined &&
    cleanedFallback &&
    leadingJoined.startsWith(cleanedFallback) &&
    leadingJoined.length >= cleanedFallback.length + 10
  ) {
    return finalizeTitle(leadingJoined);
  }
  if (cleanedFallback.length >= 5 && cleanedFallback.split(/\s+/).length >= 2) {
    return finalizeTitle(cleanedFallback);
  }

  const joined = lines
    .filter((line) => !normalizePhone(line))
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return finalizeTitle(cleanupTitleCandidate(stripPhoneLikeChunks(joined || fallbackSelected)));
}

function finalizeTitle(value) {
  const raw = cleanupTitleCandidate(String(value || '').replace(/\s+/g, ' ').trim());
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

function buildDescription(cleanText) {
  if (!cleanText) return null;
  return cleanText.slice(0, 4000);
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

  const valueWithCurrency = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{1,9}(?:[.,]\d{1,2})?)\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|мл|m(?![a-z]))/gi;
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

  // Отдельная строка вида "350.000" или "1 700 000" без слова "цена":
  // в объявлениях это часто и есть прайс.
  const standaloneGrouped = rawWithoutPhones
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d{1,3}(?:[ .,\t]\d{3})+$/.test(line));
  for (const item of standaloneGrouped) {
    const groupedValue = parseNumericPrice(item, '');
    if (groupedValue !== null) candidates.push({ value: groupedValue, weight: 2 });
  }

  if (candidates.length === 0) return null;

  // Выбираем наибольший вес, при равенстве — более правдоподобную рыночную цену.
  candidates.sort((a, b) => b.weight - a.weight || b.value - a.value);
  return candidates[0].value;
}

function parsePriceCandidatesFromFragment(fragment, allowBareNumber = false) {
  const result = [];
  const rawFragment = String(fragment || '');
  const re = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{1,9}(?:[.,]\d{1,2})?)(?:\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|т(?![a-zа-я])|тыс|k(?![a-z])|к(?![a-zа-я])|млн|мл|m(?![a-z])))?/gi;
  let match;
  while ((match = re.exec(rawFragment)) !== null) {
    const hasSuffix = Boolean(match[2]);
    if (!hasSuffix) {
      const bareToken = String(match[1] || '').trim();
      const hasThousandsGrouping = /^\d{1,3}(?:[ .,\t]\d{3})+$/.test(bareToken);
      const hasDecimalTail = /\d[.,]\d{1,2}$/.test(bareToken);
      if (!allowBareNumber && !hasThousandsGrouping) continue;

      const bareValue = parseNumericPrice(bareToken, '');
      if (bareValue === null) continue;
      if (hasDecimalTail && !hasThousandsGrouping) continue;

      if (hasThousandsGrouping) {
        if (/^\d{1,3}[.,]\d{3}$/.test(bareToken)) {
          const matchIndex = match.index || 0;
          const before = rawFragment.slice(Math.max(0, matchIndex - 18), matchIndex);
          const after = rawFragment.slice(matchIndex + bareToken.length, matchIndex + bareToken.length + 12);
          const nearPriceKeyword = /(цена|стоим|за|отдам|всего|итог|торг)/i.test(before) || /(торг|руб|₽)/i.test(after);
          if (nearPriceKeyword) {
            // "цена 1,300" в OCR локальных объявлений почти всегда означает 1 300 000.
            result.push({ value: bareValue * 1000, weight: (allowBareNumber ? 2 : 3) + 1 });
          }
        }
        result.push({ value: bareValue, weight: allowBareNumber ? 2 : 3 });
        continue;
      }

      if (!allowBareNumber) continue;
      const matchIndex = match.index || 0;
      const before = rawFragment.slice(Math.max(0, matchIndex - 18), matchIndex);
      const after = rawFragment.slice(matchIndex + bareToken.length, matchIndex + bareToken.length + 12);
      const nearPriceKeyword = /(цена|стоим|за|отдам|всего|итог|торг)/i.test(before) || /(торг|руб|₽)/i.test(after);
      if (!nearPriceKeyword) continue;
      if (/^\d{1,3}[.,]\d{3}$/.test(bareToken)) {
        // OCR часто склеивает "1 300 000" в "1,300" рядом со словом "цена".
        result.push({ value: bareValue * 1000, weight: 3 });
      }
      if (bareValue >= 20 && bareValue <= 900) {
        // В локальных объявлениях "цена 48" обычно значит 48 000.
        result.push({ value: bareValue * 1000, weight: 2 });
      } else if (bareValue >= 1000 && bareValue <= 10000000) {
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
  const token = String(rawNumber || '').trim();
  if (!token) return null;

  const suffix = String(rawSuffix || '').toLowerCase().replace(/[^a-zа-яё₽]/gi, '');
  const hasSuffixMultiplier = ['т', 'тыс', 'k', 'к', 'млн', 'мл', 'm'].includes(suffix);
  let value;

  if (hasSuffixMultiplier) {
    const decimalToken = token.replace(/\s+/g, '').replace(',', '.');
    const decimalValue = Number(decimalToken);
    if (!Number.isFinite(decimalValue)) return null;
    value = decimalValue;
  } else {
    const digits = token.replace(/[^\d]/g, '');
    if (!digits) return null;
    value = Number(digits);
    if (!Number.isFinite(value)) return null;
  }

  if (['т', 'тыс', 'k', 'к'].includes(suffix)) value *= 1000;
  if (['млн', 'мл', 'm'].includes(suffix)) value *= 1000000;

  if (value < 100) return null;
  if (value > 1000000000) return null;
  return Math.round(value);
}

function stripPhoneLikeNumbers(text) {
  return String(text || '').replace(PHONE_LIKE_RE, (match) => (normalizePhone(match) ? ' ' : match));
}

function extractContacts(text) {
  const normalized = String(text || '');

  const phoneMatches = normalized.match(PHONE_LIKE_RE) || [];
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
  const raw = String(value || '').trim();
  if (!raw || hasInvalidPhoneGrouping(raw)) return null;
  const hasLeadingPlus = raw.startsWith('+');
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hasLeadingPlus) {
    const plusPhone = `+${digits}`;
    if (plusPhone.length >= 11 && plusPhone.length <= 16) return plusPhone;
    return null;
  }

  if (digits.length === 11 && digits.startsWith('8')) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function hasInvalidPhoneGrouping(value) {
  const groups = String(value || '')
    .trim()
    .replace(/^\+/, '')
    .split(/[\s()\-]+/)
    .filter(Boolean);

  return groups.length > 1 && groups.some((group) => /\d/.test(group) && group.length > 4);
}

function stripPhoneLikeChunks(text) {
  const original = String(text || '').trim();
  if (!original) return '';
  const cleaned = original
    .replace(PHONE_LIKE_RE, ' ')
    .replace(/^[^a-zа-яё0-9]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 5 ? cleaned : original;
}

function cleanupTitleCandidate(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:цена|стоимость)\s+\d[\d.,\s]{0,24}$/i, '')
    .replace(/\s+(?:цена|стоимость)\s*$/i, '')
    .replace(/[,:;.-]+\s*$/g, '')
    .trim();
}


function detectCategory(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return 'Другое';

  const autoHeuristic =
    /(19\d{2}|20\d{2})\s*г/.test(normalized) &&
    /(объем|двигател|механика|акпп|мкпп|л\/с|привод|пробег|газ)/.test(normalized);
  if (autoHeuristic) {
    return 'Авто';
  }

  let bestCategory = 'Другое';
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
