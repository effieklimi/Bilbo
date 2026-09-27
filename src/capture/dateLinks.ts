import { parseDiaryDateKey, type DiaryDate } from "../diaryDates";

export function compactDiaryDateLabel(target: DiaryDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
    ...(target.date.getUTCFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" as const }),
  }).format(target.date);
}

export function linkedDiaryDateLabel(
  dateKey: string,
  target?: DiaryDate,
) {
  if (target) return compactDiaryDateLabel(target);

  const parsed = parseDiaryDateKey(dateKey);
  if (!parsed) return dateKey;

  return compactDiaryDateLabel(parsed);
}

export function newestLinkedDateKeys(
  dateKeys: string[],
  excluding?: string,
) {
  return Array.from(new Set(dateKeys))
    .filter((dateKey) => dateKey !== excluding)
    .sort((left, right) => right.localeCompare(left));
}
