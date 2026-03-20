import { extractStructuredData } from './adParser.js';

const MAX_DISPLAY_NAME_LENGTH = 60;
const TAXI_POST_EXPIRY_GRACE_MS = 30 * 60 * 1000;
const TAXI_MOSCOW_OFFSET_MINUTES = 3 * 60;
const TAXI_MOSCOW_OFFSET_MS = TAXI_MOSCOW_OFFSET_MINUTES * 60 * 1000;

export const TAXI_DIRECTION = Object.freeze({
  CITY: 1,
  INTERCITY: 2,
  CARGO: 3,
});
export const TAXI_ROUTE_DIRECTION = Object.freeze({
  OUTBOUND: 1,
  INBOUND: 2,
});

export const TAXI_DIRECTION_LABEL_BY_CODE = Object.freeze({
  [TAXI_DIRECTION.CITY]: 'city',
  [TAXI_DIRECTION.INTERCITY]: 'intercity',
  [TAXI_DIRECTION.CARGO]: 'cargo',
});

const TAXI_INTENT_RE = /(такси|попут|поездк|еду|поеду|подвез|подвезу|заберу|довез|выезд|выезд|маршрут|мест[ао]?|свободно|груз|посылк|багаж|доставка)/i;
const CARGO_RE = /(груз|грузоперевоз|посылк|багаж|доставка|перевозк|передать)/i;
const STRONG_CARGO_RE = /(только\s+доставк|только\s+посылк|доставка\s+посылок|грузоперевоз|пункт\s+выдачи\s+заказов|wb|wildberries|ozon)/i;
const CITY_RE = /(по городу|поездки по городу|городское такси|в черте города|по району|по району города)/i;
const CITY_LOCATION_RE = /(улиц|проспект|микрорайон|район|квартал)/i;
const ROUTE_BOUNDARY_RE = /(?=$|[,.!;]|(?:\s+(?:сегодня|завтра|послезавтра|утром|днем|днём|вечером|ночью))|\s+\d{1,2}:\d{2}|\s+\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)/i;
const PASSENGER_RE = /(мест[ао]?|человек|чел\b|проезд|посадка|высадка|от порога|до порога|еду\b)/i;
const INTERCITY_RE = /\b(?:еду|выезжаю|поеду|заберу)\s+(?:в|во|до|из|с)\s+(?:цхинвал|владикавказ)/i;
const RUS_MONTH_INDEX_BY_NAME = Object.freeze({
  января: 0,
  январь: 0,
  февраля: 1,
  февраль: 1,
  марта: 2,
  март: 2,
  апреля: 3,
  апрель: 3,
  мая: 4,
  май: 4,
  июня: 5,
  июнь: 5,
  июля: 6,
  июль: 6,
  августа: 7,
  август: 7,
  сентября: 8,
  сентябрь: 8,
  октября: 9,
  октябрь: 9,
  ноября: 10,
  ноябрь: 10,
  декабря: 11,
  декабрь: 11,
});

const KNOWN_LOCATIONS = [
  { name: 'Цхинвал', regex: /цхинвал(?:а|е|у|ом)?/giu },
  { name: 'Владикавказ', regex: /владикавказ(?:а|е|у|ом)?/giu },
];
const WEEKDAY_INDEX_BY_TOKEN = Object.freeze({
  понедель: 1,
  вторник: 2,
  сред: 3,
  четверг: 4,
  пятниц: 5,
  суббот: 6,
  воскрес: 0,
});
const VEHICLE_LABEL_RE = /^(?:машина|авто|автомобиль|марка|модель)(?=$|[\s:.-])\s*[:\-]?\s*(?:[^\p{L}\p{N}\s]+\s*)*(.+)$/iu;
const VEHICLE_BRAND_RE = /(?:toyota|lexus|hyundai|kia|bmw|mercedes|mersedes|audi|volkswagen|vw|skoda|opel|ford|honda|nissan|mazda|mitsubishi|renault|lada|granta|vesta|priora|kalina|camry|corolla|rav\s*4|rav4|alphard|chevrolet|lacetti|lanos|gazel|газель|лада|гранта|веста|приора|калина|тойота|камри|королла|альфард|нива|niva|минивэн|минивен|седан|хэтчбек|универсал)/i;
const CONTACT_MARKER_RE = /(?:^|[^\p{L}\p{N}])(?:тел(?:ефон)?|ватсап|ватсапп|вацап|васап|вотсап|whatsapp|telegram|телеграм(?:м)?|телега|тг|tg|max)(?=$|[^\p{L}\p{N}]).*$/iu;

function getOtherKnownLocation(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;

  const match = KNOWN_LOCATIONS.find((location) => location.name.toLowerCase() === normalized);
  if (!match) return null;

  return KNOWN_LOCATIONS.find((location) => location.name !== match.name)?.name || null;
}

function normalizeText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').trim();
}

function splitLines(text) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function truncateText(value, maxLength = MAX_DISPLAY_NAME_LENGTH) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function normalizePlace(value) {
  const normalized = String(value || '')
    .replace(/^[^A-Za-zА-Яа-яЁё]+/g, '')
    .replace(/[|,.;:!]+$/g, '')
    .replace(/\b(?:сегодня|завтра|послезавтра|утром|днем|днём|вечером|ночью)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  if (normalized.length < 2 || normalized.length > 40) return null;

  for (const location of KNOWN_LOCATIONS) {
    const anchoredRegex = new RegExp(`^${location.regex.source}$`, 'iu');
    if (anchoredRegex.test(normalized)) {
      return location.name;
    }
  }

  return normalized;
}

function normalizeRouteLine(value) {
  return String(value || '')
    .replace(/▶️|➡️|🛫|✈️|🚄|=>|→|[-–—>]+/gu, ' -> ')
    .replace(/🛬|🌆|🏙️/gu, ' ')
    .replace(/[^\p{L}\p{N}\s>.,!;:()/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNonLetterPrefix(value) {
  return String(value || '').replace(/^[^\p{L}\p{N}]+/gu, '').trim();
}

function normalizeTemporalText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/▶️|➡️|🛫|✈️|🚄|=>|→/gu, ' ')
    .replace(/[^\p{L}\p{N}\s:.,;!()/-]/gu, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/(\d)\s*[гg]\.?\b/giu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseReferenceDate(referenceDate) {
  if (referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())) {
    return referenceDate;
  }

  if (typeof referenceDate === 'number' && Number.isFinite(referenceDate)) {
    const normalized = new Date(referenceDate * 1000);
    return Number.isNaN(normalized.getTime()) ? new Date() : normalized;
  }

  if (typeof referenceDate === 'bigint') {
    const normalized = new Date(Number(referenceDate) * 1000);
    return Number.isNaN(normalized.getTime()) ? new Date() : normalized;
  }

  const parsed = new Date(referenceDate || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toMoscowShiftedDate(value) {
  const date = parseReferenceDate(value);
  return new Date(date.getTime() + TAXI_MOSCOW_OFFSET_MS);
}

function getMoscowDateTimeParts(value) {
  const shifted = toMoscowShiftedDate(value);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function buildMoscowIso({ year, monthIndex, day, hours = 0, minutes = 0 }) {
  const utcMs = Date.UTC(year, monthIndex, day, hours, minutes, 0, 0) - TAXI_MOSCOW_OFFSET_MS;
  const shifted = new Date(utcMs + TAXI_MOSCOW_OFFSET_MS);
  if (
    shifted.getUTCFullYear() !== year
    || shifted.getUTCMonth() !== monthIndex
    || shifted.getUTCDate() !== day
    || shifted.getUTCHours() !== hours
    || shifted.getUTCMinutes() !== minutes
  ) {
    return null;
  }

  return new Date(utcMs).toISOString();
}

function addDaysToMoscowCalendarDate({ year, monthIndex, day }, diff) {
  const date = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + diff);
  return {
    year: date.getUTCFullYear(),
    monthIndex: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function extractDepartureTime(text) {
  const normalized = normalizeTemporalText(text);
  if (!normalized) return null;

  const exactTimeMatches = normalized.matchAll(/(?<!\d)([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)(?:\s*[-–]\s*([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d))?(?!\d)/gi);
  for (const exactTimeMatch of exactTimeMatches) {
    const matchEndIndex = Number(exactTimeMatch.index || 0) + exactTimeMatch[0].length;
    const trailingSlice = normalized.slice(matchEndIndex);
    if (/^\.\d/.test(trailingSlice)) continue;

    return {
      hours: Number.parseInt(exactTimeMatch[1], 10),
      minutes: Number.parseInt(exactTimeMatch[2], 10),
    };
  }

  if (/(время|выезд|еду|час(?:ов|а)?)/i.test(normalized)) {
    const hourRangeMatch = normalized.match(/(?<!\d)([01]?\d|2[0-3])\s*[-–]\s*([01]?\d|2[0-3])(?:\s*час(?:ов|а)?|\s*(?:утра|вечера|дня|ночи))?(?=$|[^\d])/i);
    if (hourRangeMatch) {
      return {
        hours: Number.parseInt(hourRangeMatch[1], 10),
        minutes: 0,
      };
    }
  }

  const hourOnlyMatch = normalized.match(/(?:^|[\s,(])(?:в|с|к|около|примерно)?\s*([01]?\d|2[0-3])\s*(?:час(?:ов|а)?|утра|вечера|дня|ночи)(?=$|[\s.,!;:)])/i);
  if (hourOnlyMatch) {
    return {
      hours: Number.parseInt(hourOnlyMatch[1], 10),
      minutes: 0,
    };
  }

  return null;
}

function extractRelativeDepartureDate(text, referenceDate) {
  const normalized = normalizeTemporalText(text).toLowerCase();
  if (!normalized) return null;

  const reference = getMoscowDateTimeParts(referenceDate);
  const base = { year: reference.year, monthIndex: reference.monthIndex, day: reference.day, weekday: reference.weekday };

  if (normalized.includes('послезавтра')) {
    return addDaysToMoscowCalendarDate(base, 2);
  }
  if (normalized.includes('завтра')) {
    return addDaysToMoscowCalendarDate(base, 1);
  }
  if (normalized.includes('сегодня')) {
    return base;
  }

  for (const [token, weekdayIndex] of Object.entries(WEEKDAY_INDEX_BY_TOKEN)) {
    if (!normalized.includes(token)) continue;
    const diff = (weekdayIndex - base.weekday + 7) % 7;
    return addDaysToMoscowCalendarDate(base, diff);
  }

  return null;
}

function extractAbsoluteDepartureDate(text, referenceDate) {
  const normalized = normalizeTemporalText(text).toLowerCase();
  if (!normalized) return null;

  const reference = getMoscowDateTimeParts(referenceDate);

  const dottedDateMatch = normalized.match(/(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?!\d)/);
  if (dottedDateMatch) {
    const day = Number.parseInt(dottedDateMatch[1], 10);
    const month = Number.parseInt(dottedDateMatch[2], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const monthIndex = month - 1;
    const rawYear = dottedDateMatch[3];
    const year = rawYear
      ? (rawYear.length === 2 ? 2000 + Number.parseInt(rawYear, 10) : Number.parseInt(rawYear, 10))
      : reference.year;
    return { year, monthIndex, day };
  }

  const monthNameMatch = normalized.match(/(?<!\d)(\d{1,2})\s+(января|январь|февраля|февраль|марта|март|апреля|апрель|мая|май|июня|июнь|июля|июль|августа|август|сентября|сентябрь|октября|октябрь|ноября|ноябрь|декабря|декабрь)(?:\s+(\d{4}))?/i);
  if (monthNameMatch) {
    const day = Number.parseInt(monthNameMatch[1], 10);
    const monthIndex = RUS_MONTH_INDEX_BY_NAME[monthNameMatch[2].toLowerCase()];
    const year = monthNameMatch[3] ? Number.parseInt(monthNameMatch[3], 10) : reference.year;
    if (Number.isInteger(monthIndex)) {
      return { year, monthIndex, day };
    }
  }

  const dayOnlyMatch = normalized.match(/(?<!\d)(\d{1,2})\s*числ[ао]?(?!\d)/i);
  if (dayOnlyMatch) {
    const day = Number.parseInt(dayOnlyMatch[1], 10);
    const referenceMonthIndex = reference.monthIndex;
    const referenceYear = reference.year;

    let candidate = { year: referenceYear, monthIndex: referenceMonthIndex, day };
    const candidateIso = buildMoscowIso({ ...candidate });
    const previousDayStartIso = buildMoscowIso(addDaysToMoscowCalendarDate({
      year: referenceYear,
      monthIndex: referenceMonthIndex,
      day: reference.day,
    }, -1));
    if (
      candidateIso
      && previousDayStartIso
      && Date.parse(candidateIso) < Date.parse(previousDayStartIso)
    ) {
      const nextMonthDate = new Date(Date.UTC(referenceYear, referenceMonthIndex + 1, 1, 12, 0, 0, 0));
      candidate = { year: nextMonthDate.getUTCFullYear(), monthIndex: nextMonthDate.getUTCMonth(), day };
    }
    return candidate;
  }

  return null;
}

function extractRelativeDepartureOffsetMs(text) {
  const normalized = normalizeTemporalText(text).toLowerCase();
  if (!normalized) return null;

  if (/\bсейчас\b/i.test(normalized)) return 0;
  if (/через\s+пол\s+часа/i.test(normalized)) return 30 * 60 * 1000;
  const minuteOffsetMatch = normalized.match(/через\s+(\d{1,3})\s+мин(?:ут(?:[уы])?)?/i);
  if (minuteOffsetMatch) {
    const minutes = Number.parseInt(minuteOffsetMatch[1], 10);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 180) {
      return minutes * 60 * 1000;
    }
  }
  if (/(?:через|в\s+течени[еи])\s+час/i.test(normalized)) return 60 * 60 * 1000;

  return null;
}

export function resolveTaxiDepartureAt(text, referenceDate = null) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const relativeDate = extractRelativeDepartureDate(normalized, referenceDate);
  const absoluteDate = extractAbsoluteDepartureDate(normalized, referenceDate);
  const time = extractDepartureTime(normalized);
  const relativeOffsetMs = extractRelativeDepartureOffsetMs(normalized);
  const reference = parseReferenceDate(referenceDate);
  const referenceMoscowParts = getMoscowDateTimeParts(reference);

  if (absoluteDate) {
    return buildMoscowIso({
      year: absoluteDate.year,
      monthIndex: absoluteDate.monthIndex,
      day: absoluteDate.day,
      hours: time?.hours || 0,
      minutes: time?.minutes || 0,
    });
  }

  if (relativeDate) {
    return buildMoscowIso({
      year: relativeDate.year,
      monthIndex: relativeDate.monthIndex,
      day: relativeDate.day,
      hours: time?.hours || 0,
      minutes: time?.minutes || 0,
    });
  }

  if (time) {
    return buildMoscowIso({
      year: referenceMoscowParts.year,
      monthIndex: referenceMoscowParts.monthIndex,
      day: referenceMoscowParts.day,
      hours: time.hours,
      minutes: time.minutes,
    });
  }

  if (relativeOffsetMs !== null) {
    return new Date(reference.getTime() + relativeOffsetMs).toISOString();
  }

  return null;
}

export function isTaxiOfferExpired(text, referenceDate = null, now = new Date()) {
  const departureAt = resolveTaxiDepartureAt(text, referenceDate);
  if (!departureAt) return false;

  const departureTime = new Date(departureAt).getTime();
  if (!Number.isFinite(departureTime)) return false;

  const nowTime = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  return departureTime + TAXI_POST_EXPIRY_GRACE_MS < nowTime;
}

export function extractTaxiPrice(text, fallbackPrice = null) {
  const normalized = normalizeRouteLine(text).toLowerCase();
  if (!normalized) return fallbackPrice;

  const keywordPricePatterns = [
    /(?:проезд|цена|стоимость)\s*[:\-]?\s*(\d{2,5})(?!\d)(?!\s*[:.]\s*\d)/i,
    /(?:проезд|цена|стоимость)\s*[:\-]?\s*(\d{2,5})(?!\d)\s*(?:руб|р\b|₽)/i,
  ];

  for (const pattern of keywordPricePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  const seatPricePatterns = [
    /(?:мест[ао]?|чел(?:овек[а-я]*)?)\s*(?:по|за)\s*(\d{3,5})(?!\d)/i,
    /по\s*(\d{3,5})(?!\d)\s*(?:руб|р\b|₽)/i,
    /(?:мест[ао]?|чел(?:овек[а-я]*)?)\s*(\d{3,5})(?!\d)\s*(?:руб|р\b|₽)/i,
    /(\d{3,5})(?!\d)\s*(?:руб|р\b|₽)\s*за\s*(?:мест[ао]?|чел(?:овек[а-я]*)?)/i,
  ];

  for (const pattern of seatPricePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  return fallbackPrice;
}

function findKnownLocationMentions(text) {
  const normalized = normalizeRouteLine(text);
  const mentions = [];

  for (const location of KNOWN_LOCATIONS) {
    const regex = new RegExp(location.regex);
    for (const match of normalized.matchAll(regex)) {
      const index = Number(match.index ?? -1);
      if (index < 0) continue;
      mentions.push({ name: location.name, index });
    }
  }

  return mentions.sort((left, right) => left.index - right.index);
}

function extractKnownLocationsRoute(text) {
  const mentions = findKnownLocationMentions(text);
  if (mentions.length < 2) return null;

  for (let index = 0; index < mentions.length - 1; index += 1) {
    const current = mentions[index];
    const next = mentions[index + 1];
    if (current.name === next.name) continue;
    return buildRouteMatch(current.name, next.name);
  }

  return null;
}

function inferRouteFromSingleKnownLocation(text) {
  const lines = [...splitLines(text).slice(0, 8), normalizeText(text)].filter(Boolean);

  for (const line of lines) {
    const normalized = stripNonLetterPrefix(normalizeRouteLine(line));
    if (!normalized) continue;

    const destinationMatch = normalized.match(/^(?:во|в|до)\s+(.+)$/iu)
      || normalized.match(/(?:^|[^\p{L}\p{N}])(?:еду|поеду|выезжаю|заберу|подвезу|довезу)\s+(?:во|в|до)\s+(.+)$/iu);
    if (destinationMatch?.[1]) {
      const destination = extractSingleKnownLocation(destinationMatch[1]);
      const origin = getOtherKnownLocation(destination);
      if (origin && destination) {
        return buildRouteMatch(origin, destination);
      }
    }

    const originMatch = normalized.match(/^(?:из|с)\s+(.+)$/iu)
      || normalized.match(/(?:^|[^\p{L}\p{N}])(?:еду|поеду|выезжаю|заберу|подвезу|довезу)\s+(?:из|с)\s+(.+)$/iu);
    if (originMatch?.[1]) {
      const origin = extractSingleKnownLocation(originMatch[1]);
      const destination = getOtherKnownLocation(origin);
      if (origin && destination) {
        return buildRouteMatch(origin, destination);
      }
    }
  }

  return null;
}

function extractSingleKnownLocation(text) {
  return findKnownLocationMentions(text)[0]?.name || null;
}

function buildRouteMatch(fromPlace, toPlace) {
  const from = normalizePlace(fromPlace);
  const to = normalizePlace(toPlace);
  if (!from || !to) return null;

  return {
    fromPlace: from,
    toPlace: to,
    routeText: `${from} - ${to}`,
  };
}

function resolveRouteDirection(route) {
  if (!route?.fromPlace || !route?.toPlace) return null;
  if (route.fromPlace === 'Цхинвал' && route.toPlace === 'Владикавказ') {
    return TAXI_ROUTE_DIRECTION.OUTBOUND;
  }
  if (route.fromPlace === 'Владикавказ' && route.toPlace === 'Цхинвал') {
    return TAXI_ROUTE_DIRECTION.INBOUND;
  }
  return null;
}

function tryExtractRoute(line) {
  const normalized = normalizeRouteLine(line);
  if (!normalized) return null;

  const fromToMatch = normalized.match(
    new RegExp(`\\bиз\\s+([A-Za-zА-Яа-яЁё\\s-]{2,40}?)\\s+(?:в|до)\\s+([A-Za-zА-Яа-яЁё\\s-]{2,40}?)${ROUTE_BOUNDARY_RE.source}`, 'i')
  );
  if (fromToMatch) {
    return buildRouteMatch(fromToMatch[1], fromToMatch[2]);
  }

  const directRouteMatch = normalized.match(
    new RegExp(`([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\\s-]{1,40}?)\\s*->\\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\\s-]{1,40}?)${ROUTE_BOUNDARY_RE.source}`, 'i')
  );
  if (directRouteMatch) {
    return buildRouteMatch(directRouteMatch[1], directRouteMatch[2]);
  }

  return null;
}

function extractRoute(text) {
  const lines = splitLines(text);
  for (const line of lines.slice(0, 5)) {
    const route = tryExtractRoute(line);
    if (route) return route;
  }

  const knownLocationsRoute = extractKnownLocationsRoute(text);
  if (knownLocationsRoute) return knownLocationsRoute;

  const inferredRoute = inferRouteFromSingleKnownLocation(text);
  if (inferredRoute) return inferredRoute;

  return tryExtractRoute(normalizeText(text));
}

function extractDepartureText(text) {
  const normalized = normalizeTemporalText(text);
  if (!normalized) return null;

  const patterns = [
    /(сейчас|через\s+пол\s+часа|через\s+\d{1,3}\s+мин(?:ут(?:[уы])?)?|в\s+течени[еи]\s+часа|через\s+час)/i,
    /((?:выезд|еду)\s*(?:в|с)?\s*\d{1,2}\s*час(?:ов|а)?(?:\s*[-–]\s*\d{1,2}\s*час(?:ов|а)?)?)/i,
    /((?:утром|днем|днём|вечером|ночью).{0,40}?(?:\d{1,2}\s*[-–]\s*\d{1,2}|\d{1,2}[:.]\d{2}|\d{1,2}\s*час(?:ов|а)?))/i,
    /((?:понедельник|вторник|среда|среду|четверг|пятница|пятницу|суббота|субботу|воскресенье)\s*(?:\((?:\d{2}\.\d{2}\.\d{4})\))?\s*(?:с\s*)?\d{1,2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}(?::\d{2})?)?)/i,
    /((?:утром|днем|днём|вечером|ночью)\s+\d{1,2}\s*числ[ао]?\s*(?:еду|выезд|в)?\s*(?:в|с)?\s*\d{1,2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}(?::\d{2})?)?)/i,
    /((?:утром|днем|днём|вечером|ночью)\s*(?:еду|выезд|час(?:ов|а)?)?.{0,20}?\d{1,2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}(?::\d{2})?)?)/i,
    /((?:сегодня|завтра|послезавтра).{0,24}?(?:\d{1,2}[:.]\d{2}|\d{1,2}\s*час(?:ов|а)?))/i,
    /(сегодня|завтра|послезавтра)\s*\((\d{2}\.\d{2}\.\d{4})\)\s*(?:в\s*)?(\d{1,2}:\d{2})?/i,
    /(сегодня|завтра|послезавтра)\s*(?:в\s*)?(\d{1,2}:\d{2})/i,
    /(сегодня|завтра|послезавтра)\s*(?:.*?\b(?:в|с)\s*)?(\d{1,2}(?::\d{2})?|\d{1,2}\.\d{2})(?:\s*[-–]\s*(\d{1,2}(?::\d{2})?|\d{1,2}\.\d{2}))?/i,
    /(сегодня|завтра|послезавтра)/i,
    /(?<!\d)(\d{2}\.\d{2}\.\d{4})(?:\s*(?:в\s*)?(\d{1,2}:\d{2}))?/i,
    /(?<!\d)(\d{2}\.\d{2})(?:\s*(?:в\s*)?(\d{1,2}:\d{2}))?/i,
    /(?<!\d)(\d{1,2})\s*числ[ао]?(?:\s*(?:в|с)\s*)?(\d{1,2}(?::\d{2})?|\d{1,2}\.\d{2})?/i,
    /(?<!\d)(\d{1,2}:\d{2})(?!\d)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const value = match
      .slice(1)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (value) return value;
  }

  return null;
}

function parseSeatCount(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const patterns = [
    /(?:свободно|осталось|есть)\s*(\d{1,2})\s*(?:мест[ао]?|чел(?:овек[а-я]*)?)/i,
    /(\d{1,2})\s*(?:свободн(?:ых)?\s*)?(?:мест[ао]?|чел(?:овек[а-я]*)?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isInteger(value) && value >= 0 && value <= 20) {
      return value;
    }
  }

  return null;
}

function normalizeVehicleCandidate(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimVehicleTail(value) {
  const firstSegment = String(value || '')
    .split(/[;,]/, 1)[0]
    .replace(/[^\p{L}\p{N}\s:+.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return String(firstSegment || '')
    .replace(/^(?:я\s+)?водитель(?=$|[^\p{L}\p{N}])[\s:.-]*/iu, '')
    .replace(/^не\s+машина\s+а\s+ракета(?=$|[^\p{L}\p{N}])[\s:.-]*/iu, '')
    .replace(/\b(?:есть|свободно|осталось)\b.*$/i, '')
    .replace(/\b\d{1,2}\s*(?:-\s*\d{1,2}\s*)?(?:мест[ао]?|чел(?:овек[а-я]*)?)\b.*$/i, '')
    .replace(/\b\d{3,5}\s*(?:руб(?:лей)?|р\b|₽)\b.*$/i, '')
    .replace(CONTACT_MARKER_RE, '')
    .replace(/\s+на\s+ракетн\p{L}*.*$/iu, '')
    .replace(/\b(?:время|выезд|еду|поеду|посадка|высадка|проезд)\b.*$/i, '')
    .replace(/[,:;.-]+$/g, '')
    .trim();
}

function isVehicleCandidate(value) {
  const normalized = normalizeVehicleCandidate(trimVehicleTail(value));
  if (!normalized || normalized.length < 2 || normalized.length > 60) return false;
  if (!VEHICLE_BRAND_RE.test(normalized)) return false;
  if (/\b(?:цхинвал|владикавказ|сегодня|завтра|послезавтра|выезд|еду|мест[ао]?|чел\b|руб|₽|посадка|высадка|телефон|ватсап|whatsapp|telegram)\b/i.test(normalized)) {
    return false;
  }

  return true;
}

function extractVehicle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  for (const line of splitLines(normalized)) {
    const match = line.match(VEHICLE_LABEL_RE);
    if (!match) continue;
    const vehicle = normalizeVehicleCandidate(trimVehicleTail(match[1]));
    if (vehicle) {
      return truncateText(vehicle, 80);
    }
  }

  for (const line of splitLines(normalized)) {
    if (!isVehicleCandidate(line)) continue;
    return truncateText(normalizeVehicleCandidate(trimVehicleTail(line)), 80);
  }

  return null;
}

export function detectTaxiDirection(text, route = null) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return TAXI_DIRECTION.INTERCITY;

  const hasCargoIntent = CARGO_RE.test(normalized);
  const hasStrongCargoIntent = STRONG_CARGO_RE.test(normalized);
  const hasPassengerIntent = PASSENGER_RE.test(normalized);

  if (hasStrongCargoIntent && !hasPassengerIntent) return TAXI_DIRECTION.CARGO;
  if (hasCargoIntent && !hasPassengerIntent && !route?.routeText) return TAXI_DIRECTION.CARGO;

  if (route?.fromPlace && route?.toPlace) {
    return route.fromPlace.toLowerCase() === route.toPlace.toLowerCase()
      ? TAXI_DIRECTION.CITY
      : TAXI_DIRECTION.INTERCITY;
  }

  if (INTERCITY_RE.test(normalized)) return TAXI_DIRECTION.INTERCITY;
  if (CITY_RE.test(normalized) || CITY_LOCATION_RE.test(normalized)) return TAXI_DIRECTION.CITY;

  return TAXI_DIRECTION.INTERCITY;
}

export function looksLikeTaxiOffer(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const route = extractRoute(normalized);
  const base = extractStructuredData(normalized);

  let score = 0;
  if (route?.routeText) score += 3;
  if (TAXI_INTENT_RE.test(normalized)) score += 2;
  if (base.priceValue !== null) score += 1;
  if (base.contactPhone || base.contactUsername) score += 1;
  if (extractDepartureText(normalized)) score += 1;
  if (parseSeatCount(normalized) !== null) score += 1;

  return score >= 3;
}

function buildDisplayName(route, fallbackTitle, text) {
  if (route?.routeText) {
    return truncateText(route.routeText);
  }

  const singleLocation = extractSingleKnownLocation(text);
  if (singleLocation) {
    if (/\b(?:еду|поеду|выезжаю|заберу)\s+(?:в|во|до)\b/i.test(text)) {
      return `Поездка в ${singleLocation}`;
    }
    if (/\b(?:еду|поеду|выезжаю|заберу)\s+(?:из|с)\b/i.test(text)) {
      return `Поездка из ${singleLocation}`;
    }
  }

  const title = truncateText(fallbackTitle);
  if (title) return title;

  const firstLine = truncateText(splitLines(text)[0] || '');
  return firstLine || 'Поездка';
}

export function extractTaxiStructuredData(text) {
  const normalized = normalizeText(text);
  const base = extractStructuredData(normalized);
  const route = extractRoute(normalized);
  const direction = detectTaxiDirection(normalized, route);
  const routeDirection = direction === TAXI_DIRECTION.INTERCITY ? resolveRouteDirection(route) : null;
  const departureText = extractDepartureText(normalized);
  const seatsFree = parseSeatCount(normalized);
  const vehicle = extractVehicle(normalized);
  const displayName = buildDisplayName(route, base.title, normalized);

  return {
    title: displayName,
    displayName,
    description: normalized || null,
    rawText: normalized || null,
    priceValue: extractTaxiPrice(normalized, base.priceValue),
    contactPhone: base.contactPhone,
    contactUsername: base.contactUsername,
    contactText: base.contactText,
    direction,
    directionName: TAXI_DIRECTION_LABEL_BY_CODE[direction] || 'intercity',
    routeDirection,
    fromPlace: route?.fromPlace || null,
    toPlace: route?.toPlace || null,
    routeText: route?.routeText || null,
    departureAt: departureText,
    departureText,
    seatsTotal: null,
    seatsFree,
    vehicle,
  };
}
