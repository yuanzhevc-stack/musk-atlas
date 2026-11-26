/** How the reading desk shows lessons: gallery, table, or board, plus filter and sort. */
import { lessonStats, type Item, type Lesson } from "./model";

export const DESK_VIEWS = ["gallery", "table", "board"] as const;
export type DeskView = (typeof DESK_VIEWS)[number];

export const KIND_FILTERS = ["all", "video", "text"] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];

export const LANES = ["fresh", "going", "known"] as const;
export type Lane = (typeof LANES)[number];

export const LESSON_SORTS = ["opened", "created", "title", "author", "known", "blue"] as const;
export type LessonSort = (typeof LESSON_SORTS)[number];

export const VIEW_LABEL: Record<DeskView, string> = { gallery: "画廊", table: "表格", board: "看板" };
export const KIND_LABEL: Record<KindFilter, string> = { all: "全部", video: "视频", text: "文本" };
export const LANE_LABEL: Record<Lane, string> = { fresh: "未开始", going: "进行中", known: "已熟悉" };
export const SORT_LABEL: Record<LessonSort, string> = {
  opened: "最近打开",
  created: "最近加入",
  title: "标题",
  author: "作者",
  known: "已知比例",
  blue: "生词最多",
};

export interface LessonRow {
  id: string;
  title: string;
  video: boolean;
  author: string;
  created: number;
  opened: number;
  unique: number;
  blue: number;
  learning: number;
  known: number;
  lane: Lane;
}

export interface DeskQuery {
  q: string;
  kind: KindFilter;
  lane: Lane | "all";
  /** Empty means every author. Compared to `yt.author`. */
  author: string;
  sort: LessonSort;
}

const VIDEO = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|v\/))([A-Za-z0-9_-]{11})/;

function looksLikeVideo(lesson: Lesson) {
  if (lesson.yt) return true;
  const url = lesson.url?.trim() ?? "";
  return /^[A-Za-z0-9_-]{11}$/.test(url) || VIDEO.test(url);
}

export function lessonRow(lesson: Lesson, items: Record<string, Item>): LessonRow {
  const stats = lessonStats(lesson.text, items);
  const known = stats.unique ? Math.round(((stats.unique - stats.blue - stats.learning) / stats.unique) * 100) : 0;
  const opened = lesson.opened ?? 0;
  const lane: Lane = known >= 70 && stats.unique > 0 ? "known" : opened > 0 || known > 0 || stats.learning > 0 ? "going" : "fresh";
  return {
    id: lesson.id,
    title: lesson.title || "未命名",
    video: looksLikeVideo(lesson),
    author: lesson.yt?.author ?? "",
    created: lesson.created,
    opened,
    unique: stats.unique,
    blue: stats.blue,
    learning: stats.learning,
    known,
    lane,
  };
}

export function videoAuthors(lessons: Lesson[]): string[] {
  const names = new Set<string>();
  for (const lesson of lessons) {
    const name = lesson.yt?.author?.trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh"));
}

function sameAuthor(row: string, picked: string) {
  return row.trim().toLowerCase() === picked.trim().toLowerCase();
}

export function filterLessons(rows: LessonRow[], query: Pick<DeskQuery, "q" | "kind" | "lane" | "author">): LessonRow[] {
  const q = query.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (query.kind === "video" && !row.video) return false;
    if (query.kind === "text" && row.video) return false;
    if (query.lane !== "all" && row.lane !== query.lane) return false;
    if (query.author && !sameAuthor(row.author, query.author)) return false;
    if (!q) return true;
    return `${row.title} ${row.author}`.toLowerCase().includes(q);
  });
}

export function sortLessons(rows: LessonRow[], sort: LessonSort): LessonRow[] {
  const copy = [...rows];
  const byTitle = (a: LessonRow, b: LessonRow) => a.title.localeCompare(b.title, "zh");
  copy.sort((a, b) => {
    if (sort === "title") return byTitle(a, b);
    if (sort === "author") {
      const aa = a.author.trim();
      const bb = b.author.trim();
      if (!aa !== !bb) return aa ? -1 : 1;
      return aa.localeCompare(bb, "zh") || byTitle(a, b);
    }
    if (sort === "created") return b.created - a.created || byTitle(a, b);
    if (sort === "known") return b.known - a.known || byTitle(a, b);
    if (sort === "blue") return b.blue - a.blue || byTitle(a, b);
    return (b.opened || b.created) - (a.opened || a.created) || byTitle(a, b);
  });
  return copy;
}

export function deskRows(lessons: Lesson[], items: Record<string, Item>, query: DeskQuery): LessonRow[] {
  return sortLessons(filterLessons(lessons.map((lesson) => lessonRow(lesson, items)), query), query.sort);
}
