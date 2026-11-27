'use strict';

// Calendar days for history repair are always Asia/Shanghai (CST, no DST).
const DAY_TZ = 'Asia/Shanghai';

function dayKeyShanghai(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(ms)));
}

function dayBoundsShanghai(day) {
  const start = Date.parse(String(day || '') + 'T00:00:00+08:00');
  if (!Number.isFinite(start)) return null;
  return { start, end: start + 86400000 };
}

module.exports = { DAY_TZ, dayKeyShanghai, dayBoundsShanghai };
