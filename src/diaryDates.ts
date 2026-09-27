export type DiaryDate = {
  dateKey: string;
  date: Date;
};

const DIARY_FILE_NAME = /^(\d{1,2})-(\d{1,2})-(\d{4})\.(?:md|markdown)$/i;
const DIARY_DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function diaryDate(year: number, month: number, day: number): DiaryDate | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  // Store filename dates at UTC noon and always format/read them in UTC. This
  // keeps a calendar day stable if the Mac changes timezone while Bilbo runs.
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  return {
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    date,
  };
}

export function parseDiaryFileDate(fileName: string) {
  const match = DIARY_FILE_NAME.exec(fileName);
  if (!match) return null;

  return diaryDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

export function parseDiaryDateKey(dateKey: string) {
  const match = DIARY_DATE_KEY.exec(dateKey);
  if (!match) return null;

  return diaryDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function formatLongDiaryDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
