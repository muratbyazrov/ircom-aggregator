import { createHash } from 'node:crypto';

const MAX_TITLE_LENGTH = 50;
const PHONE_LIKE_RE = /(?<![\d,.])(?:\+?\d{10,15}|\+?\d{1,4}(?:[\s()-]+\d{1,4}){2,})(?![\d])/gu;
const TELEGRAM_MARKER_PATTERN = '(?:telegram|телеграм(?:м)?|телега|тг|tg)';
const WHATSAPP_MARKER_PATTERN = '(?:wh(?:a)?ts?\\s*app|wats?\\s*app|ватсап|ватсапп|вацап|вацап|ваца|вац|вотсап|васап)';
const PRICE_HINT_RE = /(цена|стоимость|продаю\s+за|за\s+\d|отдам|всего|итог|руб|₽|тыс|тысяч|тыр|тр(?![а-яё])|торг|🍋|млн|мл)/i;
const LISTING_INTENT_RE = /(продам|продаю|продается|продаётся|продажа|продажи|отдам|куплю|сдам|сдается|сдаётся|сниму|аренда|обмен|ваканси|ищу|ищем|требуетс|зарплат|резюме)/i;
const SERVICE_INTENT_RE = /(услуг|оказываю|предлагаю услуги|на дому|с выездом|выезд|мастер на час|маникюр|педикюр|бров|ресниц|парикмахер|косметолог|сантехник|электрик|репетитор|курсы|обучен|уборк|клининг|шиномонтаж|автосервис|разработка сайтов|telegram-бот|telegram bot|телеграм-бот|чат-бот|бот для|бот на заказ|ремонт[а-я]* автостек|ремонт[а-я]* лобов|ремонт[а-я]* квартир|ремонт[а-я]* под ключ|демонтаж|монтаж|укладка кафеля)/i;
const VALID_TELEGRAM_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

const LISTING_CATEGORY_RULES = [
  { code: 'transport', name: 'Авто', keywords: ['авто', 'машин', 'автомоб', 'toyota', 'bmw', 'mercedes', 'lada', 'kia', 'hyundai', 'ваз', 'пробег', 'двигател', 'акпп', 'мкпп', 'vin', 'л/с', 'мотор', 'привод', 'механика', 'бампер'] },
  { code: 'real_estate', name: 'Недвижимость', keywords: ['квартир', 'дом', 'комнат', 'аренда', 'сдам', 'сдается', 'недвижим', 'офис', 'посуточно', 'ипотек', 'район', 'раен', 'участок', 'земля'] },
  { code: 'electronics', name: 'Электроника', keywords: ['iphone', 'айфон', 'samsung', 'xiaomi', 'телефон', 'смартфон', 'ноутбук', 'macbook', 'пк', 'playstation', 'ps5', 'ipad', 'наушник', 'xbox', 'x box'] },
  { code: 'jobs', name: 'Работа', keywords: ['ваканси', 'работ', 'зарплат', 'требуетс', 'график', 'сотрудник', 'резюме'] },
  { code: 'for_home', name: 'Для дома', keywords: ['диван', 'кровать', 'шкаф', 'стол', 'мебел', 'холодильник', 'стирал', 'посуда', 'сад'] },
  { code: 'children', name: 'Для детей', keywords: ['детск', 'коляска', 'игрушк', 'подгуз', 'школ', 'самокат'] },
  { code: 'other', name: 'Другое', keywords: ['услуг', 'ремонт', 'мастер', 'доставка', 'перевоз', 'маникюр', 'парикмахер', 'сантехник', 'электрик', 'куртка', 'платье', 'кроссовк', 'обув', 'одежд', 'размер', 'брюки', 'футболк', 'кот', 'кошка', 'собак', 'щенок', 'питом', 'ветеринар', 'корм', 'велосипед', 'спорт', 'гантел', 'рыбалк', 'охота', 'музык', 'гитара'] },
];

const SERVICE_CATEGORY_RULES = [
  { code: 'beauty', name: 'Красота', keywords: ['маникюр', 'педикюр', 'бров', 'ресниц', 'парикмахер', 'окрашиван', 'стрижк', 'укладк', 'макияж', 'косметолог', 'эпиляц', 'шугаринг', 'барбер'] },
  { code: 'repair', name: 'Ремонт', keywords: ['ремонт', 'мастер', 'сантехник', 'электрик', 'почин', 'установк', 'монтаж', 'кондиционер', 'бойлер', 'котел', 'холодильник', 'стирал'] },
  { code: 'construction', name: 'Строительство', keywords: ['строитель', 'строительств', 'отделк', 'штукатур', 'маляр', 'плиточ', 'кафель', 'кровл', 'фасад', 'бетон', 'фундамент', 'сварк', 'демонтаж', 'монтаж'] },
  { code: 'education', name: 'Обучение', keywords: ['обучен', 'репетитор', 'курсы', 'уроки', 'подготов', 'подготовк', 'английск', 'математ', 'школа', 'занятия', 'логопед'] },
  { code: 'it', name: 'IT-услуги', keywords: ['it', 'айти', 'сайт', 'лендинг', 'telegram bot', 'telegram-бот', 'телеграм-бот', 'чат-бот', 'бот для', 'бот на заказ', 'разработк', 'программист', 'seo', 'smm', 'таргет', 'настройк пк', 'настройка пк', 'компьютер'] },
  { code: 'auto_service', name: 'Автосервис', keywords: ['автосервис', 'сто', 'шиномонтаж', 'развал', 'сход', 'диагностик', 'замена масла', 'автоэлектрик', 'кузовн', 'полировк', 'тонировк', 'автостекл', 'лобов'] },
  { code: 'cleaning', name: 'Уборка', keywords: ['уборк', 'клининг', 'химчист', 'мойка окон', 'генеральн уборк', 'домработниц', 'убираю', 'чистка'] },
  { code: 'other', name: 'Другое', keywords: ['услуг', 'доставка', 'перевоз', 'грузчик', 'помощь', 'на заказ'] },
];

export const FALLBACK_LISTING_CATEGORY_BY_CODE = Object.freeze(
  Object.fromEntries(LISTING_CATEGORY_RULES.map((rule) => [rule.code, rule.name]))
);

export const FALLBACK_SERVICE_CATEGORY_BY_CODE = Object.freeze(
  Object.fromEntries(SERVICE_CATEGORY_RULES.map((rule) => [rule.code, rule.name]))
);

export function looksLikeAd(text, adKeywords) {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const hasAdKeyword = adKeywords.some((kw) => normalized.includes(kw));
  const hasPrice = extractPrice(normalized) !== null;
  const contacts = extractContacts(normalized);
  const hasContacts = Boolean(contacts.contactPhone || contacts.contactUsername || contacts.contactText);
  const hasSellingVerb = /(продам|продаю|куплю|сдам|ищу|обмен|торг|ваканси|работа|услуг)/i.test(normalized);
  const hasServiceIntent = detectPostKind(normalized) === 2 || SERVICE_INTENT_RE.test(normalized);

  let score = 0;
  if (hasAdKeyword) score += 2;
  if (hasPrice) score += 2;
  if (hasContacts) score += 1;
  if (hasSellingVerb) score += 1;
  if (hasServiceIntent) score += 2;

  return score >= 2;
}

export function detectPostKind(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return 1;

  if (/(без ремонт[а-я]*|не требует ремонт[а-я]*|не после ремонт[а-я]*)/i.test(normalized)) {
    return 1;
  }

  let listingScore = scoreCategoryRules(normalized, LISTING_CATEGORY_RULES, { includeOther: false });
  let serviceScore = scoreCategoryRules(normalized, SERVICE_CATEGORY_RULES, { includeOther: false });
  const hasListingIntent = LISTING_INTENT_RE.test(normalized);
  const hasServiceIntent = SERVICE_INTENT_RE.test(normalized);

  if (hasListingIntent) listingScore += 3;
  if (hasServiceIntent) serviceScore += 3;

  if (/(ваканси|требуетс|зарплат|резюме|сотрудник)/i.test(normalized)) listingScore += 3;
  if (/(ищем работу|ищу работу|ищем подработку|ищу подработку)/i.test(normalized)) listingScore += 4;
  if (/(с выездом|на дому|оказываю услуги|предлагаю услуги)/i.test(normalized)) serviceScore += 2;

  if (hasListingIntent && !hasServiceIntent) {
    return 1;
  }

  if (hasServiceIntent && !hasListingIntent) {
    return 2;
  }

  if (
    !hasListingIntent
    && serviceScore >= 1
    && /^(ремонт[а-я]*|маникюр|педикюр|демонтаж|монтаж|укладка|сантехник|электрик|репетитор|уборк|разработка|шиномонтаж|автосервис)/i.test(normalized)
  ) {
    return 2;
  }

  if (serviceScore >= 4 && serviceScore > listingScore) {
    return 2;
  }

  if (serviceScore >= 3 && !hasListingIntent) {
    return 2;
  }

  if (listingScore >= serviceScore) {
    return 1;
  }

  return 1;
}

export function extractStructuredData(text, options = {}) {
  const cleanText = normalizeText(text);
  const lines = splitLines(cleanText);
  const title = pickTitle(lines);
  const description = buildDescription(cleanText);
  const price = extractPrice(cleanText);
  const contacts = extractContacts(cleanText);
  const categoryCode = detectCategory(`${title || ''}\n${description || ''}`, options);
  const fallbackCategoryByCode = Number(options?.kind) === 2
    ? FALLBACK_SERVICE_CATEGORY_BY_CODE
    : FALLBACK_LISTING_CATEGORY_BY_CODE;

  return {
    title: title || null,
    description: description || null,
    priceValue: price,
    contactPhone: contacts.contactPhone,
    contactUsername: contacts.contactUsername,
    contactText: contacts.contactText,
    category: fallbackCategoryByCode[categoryCode] || 'Другое',
    categoryCode,
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

export function truncateTitle(value, maxLength = MAX_TITLE_LENGTH) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length <= maxLength) return raw;

  const sentenceEnd = raw.slice(0, maxLength + 1).search(/[.!?;:](?:\s|$)/);
  if (sentenceEnd > 10 && sentenceEnd <= maxLength) {
    return raw.slice(0, sentenceEnd + 1).trim();
  }

  const cut = raw.slice(0, maxLength + 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLength / 2)) {
    return cut.slice(0, lastSpace).trim();
  }

  return raw.slice(0, maxLength).trim();
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
    const hasPriceHint = PRICE_HINT_RE.test(line);
    if (!hasPriceHint) continue;
    for (const item of parseSpecialPriceCandidates(line)) {
      candidates.push({ value: item.value, weight: item.weight + 3 });
    }
    for (const item of parsePriceCandidatesFromFragment(line)) {
      candidates.push({ value: item.value, weight: item.weight + 3 });
    }
  }

  for (const item of parseSpecialPriceCandidates(rawWithoutPhones)) {
    candidates.push(item);
  }

  const valueWithCurrency = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{1,9}(?:[.,]\d{1,2})?)\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|тыс(?:яч(?:а|и)?)?|тыр(?![а-яё])|тр(?![а-яё])|т(?![a-zа-я])|k(?![a-z])|к(?![a-zа-я])|млн|мл|m(?![a-z]))/gi;
  let match;
  while ((match = valueWithCurrency.exec(rawWithoutPhones)) !== null) {
    if (isLikelyMileageCandidate(rawWithoutPhones, match.index || 0, match[0], match[2])) continue;
    const value = parseNumericPrice(match[1], match[2]);
    if (value !== null) candidates.push({ value, weight: 4 });
  }

  // Fallback: ищем голые числа в линиях с ценовыми маркерами (например "цена 48 торг"),
  // если формат "тыс/т" не указан, но значение выглядит как "тысячи рублей".
  const barePriceCandidates = rawWithoutPhones
    .split('\n')
    .filter((line) => /(цена|стоимость|за\s+\d|отдам|торг|🍋|млн|мл)/i.test(line))
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
  for (const item of parseSpecialPriceCandidates(rawFragment)) {
    result.push(item);
  }

  const re = /(\d{1,3}(?:[ .,\t]\d{3})+|\d{1,9}(?:[.,]\d{1,2})?)(?:\s*(₽|руб(?:\.|лей)?|р(?![a-zа-я])|тыс(?:яч(?:а|и)?)?|тыр(?![а-яё])|тр(?![а-яё])|т(?![a-zа-я])|k(?![a-z])|к(?![a-zа-я])|млн|мл|m(?![a-z])))?/gi;
  let match;
  while ((match = re.exec(rawFragment)) !== null) {
    const hasSuffix = Boolean(match[2]);
    if (hasSuffix && isLikelyMileageCandidate(rawFragment, match.index || 0, match[0], match[2])) continue;
    if (!hasSuffix) {
      const bareToken = String(match[1] || '').trim();
      if (isLikelyMileageCandidate(rawFragment, match.index || 0, bareToken)) continue;
      const hasThousandsGrouping = /^\d{1,3}(?:[ .,\t]\d{3})+$/.test(bareToken);
      const hasDecimalTail = /\d[.,]\d{1,2}$/.test(bareToken);
      if (!allowBareNumber && !hasThousandsGrouping) continue;

      if (hasDecimalTail && !hasThousandsGrouping) continue;

      let bareValue = parseNumericPrice(bareToken, '');
      if (bareValue === null && allowBareNumber && /^\d{2,3}$/.test(bareToken)) {
        bareValue = Number(bareToken);
      }
      if (bareValue === null) continue;

      if (hasThousandsGrouping) {
        if (isSingleThousandsGroupToken(bareToken)) {
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
      const hasStrongPriceKeyword = /(цена|стоим|всего|итог)/i.test(before);
      if (!nearPriceKeyword) continue;
      if (isSingleThousandsGroupToken(bareToken)) {
        // OCR часто склеивает "1 300 000" в "1,300" рядом со словом "цена".
        result.push({ value: bareValue * 1000, weight: 3 });
      }
      if (bareValue >= 20 && bareValue <= 900) {
        // В локальных объявлениях "цена 48" обычно значит 48 000.
        result.push({ value: bareValue * 1000, weight: 2 });
      } else if (bareValue >= 1000 && bareValue <= 10000000) {
        result.push({ value: bareValue, weight: hasStrongPriceKeyword ? 5 : 1 });
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

  const suffix = normalizePriceSuffix(rawSuffix);
  let value;

  if (isThousandSuffix(suffix)) {
    const groupedDigits = token.replace(/[^\d]/g, '');
    if (!groupedDigits) return null;

    if (isSingleThousandsGroupToken(token)) {
      value = Number(groupedDigits) * 1000;
    } else if (/^\d{1,3}(?:[ .,\t]\d{3})+$/.test(token) || /^\d{4,}$/.test(token)) {
      value = Number(groupedDigits);
    } else {
      const decimalToken = token.replace(/\s+/g, '').replace(',', '.');
      const decimalValue = Number(decimalToken);
      if (!Number.isFinite(decimalValue)) return null;
      value = decimalValue * 1000;
    }
  } else if (isMillionSuffix(suffix)) {
    const decimalToken = token.replace(/\s+/g, '').replace(',', '.');
    const decimalValue = Number(decimalToken);
    if (!Number.isFinite(decimalValue)) return null;
    value = decimalValue * 1000000;
  } else {
    const digits = token.replace(/[^\d]/g, '');
    if (!digits) return null;
    value = Number(digits);
    if (!Number.isFinite(value)) return null;
  }

  if (value < 100) return null;
  if (value > 1000000000) return null;
  return Math.round(value);
}

function parseSpecialPriceCandidates(fragment) {
  const result = [];
  const rawFragment = String(fragment || '');

  const lemonSplitRe = /\b(\d{1,2})\s*🍋\s*[.,]?\s*(\d{1,3})\b/gu;
  let match;
  while ((match = lemonSplitRe.exec(rawFragment)) !== null) {
    const millions = Number(match[1]);
    const thousands = Number(match[2]);
    if (!Number.isFinite(millions) || !Number.isFinite(thousands)) continue;
    result.push({ value: millions * 1000000 + thousands * 1000, weight: 7 });
  }

  const lemonSuffixRe = /(\d{1,4}(?:[.,]\d{1,3})?)\s*🍋(?=\s|$|[^\p{L}\p{N}])/gu;
  while ((match = lemonSuffixRe.exec(rawFragment)) !== null) {
    const value = parseLemonPrice(match[1]);
    if (value !== null) result.push({ value, weight: 6 });
  }

  const splitMillionRe = /(\d{1,2})\s*[.,]\s*(\d{1,3})\s*(?:млн?|мл)(?=\s|$|[^\p{L}\p{N}])/giu;
  while ((match = splitMillionRe.exec(rawFragment)) !== null) {
    const whole = Number(match[1]);
    const fraction = String(match[2] || '').trim();
    if (!Number.isFinite(whole) || !fraction) continue;
    const value = Math.round(Number(`${whole}.${fraction}`) * 1000000);
    if (!Number.isFinite(value)) continue;
    result.push({ value, weight: 6 });
  }

  const shortMillionRe = /(\d{1,2})\s*[.,]\s*(\d{1,3})\s*м(?:\s*р)?(?=\s|$|[^\p{L}\p{N}])/giu;
  while ((match = shortMillionRe.exec(rawFragment)) !== null) {
    const whole = Number(match[1]);
    const fraction = String(match[2] || '').trim();
    if (!Number.isFinite(whole) || !fraction) continue;
    const value = Math.round(Number(`${whole}.${fraction}`) * 1000000);
    if (!Number.isFinite(value)) continue;
    result.push({ value, weight: 6 });
  }

  return result;
}

function parseLemonPrice(rawToken) {
  const token = String(rawToken || '').replace(/\s+/g, '').trim();
  if (!token) return null;

  if (/^\d{3,4}$/.test(token)) {
    return Number(token) * 1000;
  }

  if (/^\d{1,2}$/.test(token)) {
    return Number(token) * 1000000;
  }

  if (/^\d{1,2}[.,]\d{1,3}$/.test(token)) {
    const decimalValue = Number(token.replace(',', '.'));
    if (!Number.isFinite(decimalValue)) return null;
    return Math.round(decimalValue * 1000000);
  }

  return null;
}

function normalizePriceSuffix(rawSuffix) {
  const suffix = String(rawSuffix || '').toLowerCase().replace(/[^a-zа-яё₽]/gi, '');
  if (suffix === 'т') return 'т';
  if (suffix === 'k') return 'k';
  if (suffix === 'к') return 'к';
  if (suffix.startsWith('тыс') || suffix.startsWith('тысяч')) return 'тыс';
  if (suffix === 'тр' || suffix === 'тыр') return 'тыс';
  if (suffix === 'млн') return 'млн';
  if (suffix === 'мл') return 'мл';
  if (suffix === 'm') return 'm';
  return suffix;
}

function isThousandSuffix(suffix) {
  return ['т', 'тыс', 'k', 'к'].includes(suffix);
}

function isMillionSuffix(suffix) {
  return ['млн', 'мл', 'm'].includes(suffix);
}

function isSingleThousandsGroupToken(token) {
  return /^\d[ .,\t]\d{3}$/.test(String(token || '').trim());
}

function isLikelyMileageCandidate(fragment, matchIndex, matchedText, rawSuffix = '') {
  const suffix = normalizePriceSuffix(rawSuffix);
  if (rawSuffix && !isThousandSuffix(suffix)) return false;

  const matchLength = String(matchedText || '').length;
  const before = String(fragment || '').slice(Math.max(0, matchIndex - 24), matchIndex);
  const after = String(fragment || '').slice(matchIndex + matchLength, matchIndex + matchLength + 24);
  const beforeTrimmed = before.trimEnd();
  const afterTrimmed = after.trimStart();

  if (/(?:^|[^\p{L}\p{N}_])пробег(?:а)?\s*$/iu.test(beforeTrimmed)) return true;
  if (/^(?:км|km|миль?)(?:\s|$|[^\p{L}\p{N}])/iu.test(afterTrimmed)) return true;
  if (/^(?:тыс\.?\s*км|т\.?\s*(?:км|м))(?:\s|$|[^\p{L}\p{N}])/iu.test(afterTrimmed)) return true;
  if (/^м(?:\s|$|[^\p{L}\p{N}])/iu.test(afterTrimmed) && /пробег/iu.test(before + after)) return true;

  return false;
}

function stripPhoneLikeNumbers(text) {
  return String(text || '').replace(PHONE_LIKE_RE, (match) => (normalizePhone(match) ? ' ' : match));
}

function buildContactMarkerRegex(pattern, flags = 'iu') {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, flags);
}

function hasContactMarker(text, pattern) {
  return buildContactMarkerRegex(pattern, 'iu').test(String(text || ''));
}

function extractPhonesWithIndices(text) {
  const normalized = String(text || '');
  const result = [];

  for (const match of normalized.matchAll(PHONE_LIKE_RE)) {
    const phone = normalizePhone(match[0]);
    const index = Number(match.index ?? -1);
    if (!phone || index < 0) continue;
    result.push({ phone, index });
  }

  return result;
}

function extractPhonesNearMarker(text, pattern, maxDistance = 48) {
  const normalized = String(text || '');
  const markerRegex = buildContactMarkerRegex(pattern, 'giu');
  const markers = [...normalized.matchAll(markerRegex)].map((match) => ({
    index: Number(match.index ?? -1),
    length: match[0].length,
  })).filter((entry) => entry.index >= 0);
  if (markers.length === 0) return [];

  const phones = extractPhonesWithIndices(normalized);
  const taggedPhones = [];

  for (const marker of markers) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const markerCenter = marker.index + Math.floor(marker.length / 2);

    for (const phone of phones) {
      const distance = Math.abs(phone.index - markerCenter);
      if (distance > maxDistance || distance >= bestDistance) continue;
      best = phone.phone;
      bestDistance = distance;
    }

    if (best) taggedPhones.push(best);
  }

  return [...new Set(taggedPhones)];
}

function normalizeTelegramAlias(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^[^@\p{L}\p{N}_-]+/gu, '')
    .replace(/[^\p{L}\p{N}_-]+$/gu, '')
    .trim();

  if (!normalized || normalized.length < 2 || normalized.length > 32) return null;
  if (/^\d{5,}$/.test(normalized)) return null;
  if (/^(?:telegram|телеграм(?:м)?|телега|тг|tg|whatsapp|ватсап|вацап|вац|вотсап)$/iu.test(normalized)) return null;
  if (/^(?:писать|пишите|звонить|звоните|желательно|номер|тел|телефон)$/iu.test(normalized)) return null;
  return normalized;
}

function extractTelegramLabels(text) {
  const normalized = String(text || '');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const validUsernames = [];
  const aliases = [];
  const markerBeforeRe = new RegExp(`${TELEGRAM_MARKER_PATTERN}\\s*[:\\-]?[\\s/|,;]*@?([\\p{L}\\p{N}_-]{2,32})\\b`, 'iu');
  const markerAfterRe = new RegExp(`@?([\\p{L}\\p{N}_-]{2,32})\\s*(?:[|/,;:-]+\\s*)?${TELEGRAM_MARKER_PATTERN}\\b`, 'iu');

  for (const line of lines) {
    const beforeMatch = line.match(markerBeforeRe);
    const afterMatch = line.match(markerAfterRe);
    const candidate = normalizeTelegramAlias(beforeMatch?.[1] || afterMatch?.[1] || '');
    if (!candidate) continue;

    if (VALID_TELEGRAM_USERNAME_RE.test(candidate)) {
      validUsernames.push(candidate);
    } else {
      aliases.push(candidate);
    }
  }

  return {
    usernames: [...new Set(validUsernames)],
    aliases: [...new Set(aliases)],
  };
}

function extractContacts(text) {
  const normalized = String(text || '');

  const phoneMatches = extractPhonesWithIndices(normalized);
  const phones = phoneMatches.map((entry) => entry.phone);
  const uniquePhones = [...new Set(phones)];

  const tgAtMatches = normalized.match(/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g) || [];
  const tgLinkMatches = normalized.match(/https?:\/\/t\.me\/([a-zA-Z0-9_]{4,32})/gi) || [];
  const telegramLabels = extractTelegramLabels(normalized);
  const usernames = [
    ...tgAtMatches.map((entry) => entry.trim().replace(/^@/, '')),
    ...tgLinkMatches
      .map((entry) => entry.match(/t\.me\/([a-zA-Z0-9_]{4,32})/i)?.[1] || '')
      .filter(Boolean),
    ...telegramLabels.usernames,
  ].filter(Boolean);
  const uniqueUsernames = [...new Set(usernames)];
  const uniqueTelegramAliases = telegramLabels.aliases.filter((alias) => !uniqueUsernames.includes(alias));
  const hasTelegramMarker = hasContactMarker(normalized, TELEGRAM_MARKER_PATTERN);
  const hasWhatsappMarker = hasContactMarker(normalized, WHATSAPP_MARKER_PATTERN);
  const telegramPhones = extractPhonesNearMarker(normalized, TELEGRAM_MARKER_PATTERN);
  const whatsappPhones = extractPhonesNearMarker(normalized, WHATSAPP_MARKER_PATTERN);

  const contactParts = [
    ...uniquePhones.map((phone) => `phone:${phone}`),
    ...uniqueUsernames.map((username) => `tg:@${username}`),
    ...uniqueTelegramAliases.map((alias) => `tg-alias:${alias}`),
    ...telegramPhones
      .filter((phone) => !uniqueUsernames.length || !whatsappPhones.includes(phone))
      .map((phone) => `tg-phone:${phone}`),
    ...whatsappPhones.map((phone) => `wa:${phone}`),
  ];
  if (hasTelegramMarker && uniqueUsernames.length === 0 && uniqueTelegramAliases.length === 0 && telegramPhones.length === 0) {
    contactParts.push('tg:mentioned');
  }
  if (hasWhatsappMarker && whatsappPhones.length === 0) {
    contactParts.push('wa:mentioned');
  }

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


function getCategoryRules(kind) {
  return Number(kind) === 2 ? SERVICE_CATEGORY_RULES : LISTING_CATEGORY_RULES;
}

function scoreCategoryRules(normalized, rules, { includeOther = true } = {}) {
  let score = 0;

  for (const rule of rules) {
    if (!includeOther && rule.code === 'other') continue;
    for (const keyword of rule.keywords) {
      if (normalized.includes(keyword)) score += 1;
    }
  }

  return score;
}

function detectCategory(text, options = {}) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return 'other';
  const kind = Number(options?.kind) === 2 ? 2 : 1;
  const categoryRules = getCategoryRules(kind);

  const autoHeuristic =
    kind === 1 &&
    /(19\d{2}|20\d{2})\s*г/.test(normalized) &&
    /(объем|двигател|механика|акпп|мкпп|л\/с|привод|пробег|газ)/.test(normalized);
  if (autoHeuristic) {
    return 'transport';
  }

  // 'other' is the fallback category and intentionally has many broad keywords.
  // We score it separately so it only wins when no specific category matches at all —
  // preventing it from drowning out more precise categories via keyword volume.
  let bestCategory = 'other';
  let bestScore = 0;

  for (const rule of categoryRules) {
    if (rule.code === 'other') continue;
    let score = 0;
    for (const keyword of rule.keywords) {
      if (normalized.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.code;
    }
  }

  return bestCategory;
}
