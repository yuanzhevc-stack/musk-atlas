import { AudioLines, BookMarked, BookOpen, BookOpenText, ChevronLeft, ChevronRight, Compass, Github, Keyboard, Moon, Search, Sun, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AtlasContext, useAtlas, useEntry } from "./atlas/context";
import { loadOpenAtlas, loadPrivateAtlas } from "./atlas/data";
import type { Atlas } from "./atlas/types";
import { REPO_URL, UPSTREAM_URL } from "./config";
import { closeWord, currentLocation, go, openWord, useLocation, type Route } from "./lib/router";
import { AtlasPage } from "./pages/Atlas";
import { MuskPage } from "./pages/Musk";
import { GlobalCard } from "./reader/GlobalCard";
import { ReaderPage } from "./pages/Reader";
import { CorpusPage } from "./pages/Corpus";
import { About } from "./pages/About";
import { Learn } from "./pages/Learn";
import { Me } from "./pages/Me";
import { Onboarding } from "./pages/Onboarding";
import { Practice } from "./pages/Practice";
import { Today } from "./pages/Today";
import { cue } from "./lib/sound";
import { store, useStore } from "./store/store";
import { EntryView } from "./ui/EntryView";
import { AmbienceController, AmbiencePicker } from "./ui/Ambience";
import { Logo } from "./ui/Logo";
import { Palette } from "./ui/Palette";
import { Sheet } from "./ui/Sheet";
import { Splash } from "./ui/Splash";
import { Toasts } from "./ui/Toast";

const NAV: { page: Route["page"]; label: string; icon: typeof Compass }[] = [
  { page: "musk", label: "Musk", icon: AudioLines },
  { page: "reader", label: "阅读", icon: BookOpenText },
  { page: "corpus", label: "语料", icon: BookMarked },
  { page: "today", label: "今日", icon: Compass },
  { page: "atlas", label: "图鉴", icon: BookOpen },
  { page: "practice", label: "练习", icon: Keyboard },
  { page: "me", label: "我的", icon: User },
];

const navOn = (cur: Route["page"], page: Route["page"]) => cur === page;

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0D1120" : "#F6F1E7");
  }, [theme]);
  return theme;
}

export default function App() {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [open, setOpen] = useState<Atlas | null>(null);
  const [priv, setPriv] = useState<Atlas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataset = useStore((s) => s.settings.dataset);
  useTheme();

  useEffect(() => {
    loadOpenAtlas().then(
      (a) => {
        setOpen(a);
        if (import.meta.env.DEV) loadPrivateAtlas(a).then(setPriv, () => null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    const next = dataset === "private" && priv ? priv : open;
    if (next && next !== atlas) {
      store.useDataset(next.id);
      setAtlas(next);
    }
  }, [dataset, open, priv, atlas]);

  if (error)
    return (
      <div className="boot">
        <Logo />
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  if (!atlas)
    return (
      <div className="boot" aria-busy="true">
        <Logo />
        <span className="spinner" />
      </div>
    );
  return (
    <AtlasContext.Provider value={atlas}>
      <Shell privateAvailable={!!priv} />
    </AtlasContext.Provider>
  );
}

function Shell({ privateAvailable }: { privateAvailable: boolean }) {
  const { route, word } = useLocation();
  const onboarded = useStore((s) => s.settings.onboarded);
  const theme = useStore((s) => s.settings.theme);
  const [palette, setPalette] = useState(false);
  const [splash, setSplash] = useState(false);
  const focus = route.page === "learn";

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !typing && !focus) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [focus]);

  useEffect(() => {
    if (!word) window.scrollTo({ top: 0 });
  }, [route.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className={`app ${focus ? "is-focus" : ""}`}>
      {!focus && (
        <header className="topbar">
          <a className="topbar-logo" href="#/" aria-label="Musk Atlas 首页">
            <Logo />
          </a>
          <nav className="topnav" aria-label="主导航">
            {NAV.map(({ page, label }) => (
              <a key={page} href={page === "musk" ? "#/" : `#/${page}`} className={navOn(route.page, page) ? "is-on" : ""} aria-current={navOn(route.page, page) ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="topbar-tools">
            <button className="search-pill" onClick={() => setPalette(true)} aria-label="查词或中文说法">
              <Search size={17} />
              <span>词库</span>
              <kbd>⌘K</kbd>
            </button>
            <AmbiencePicker />
            <button className="icon-btn" onClick={() => store.settings({ theme: dark ? "light" : "dark" })} aria-label={dark ? "切换到浅色" : "切换到深色"}>
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <a className="icon-btn hide-sm" href="#/about" aria-label="关于与开源" title="关于与开源">
              <Github size={19} />
            </a>
          </div>
        </header>
      )}

      <main className="main" id="main">
        {route.page === "musk" && <MuskPage q={route.q} c={route.c} />}
        {route.page === "reader" && <ReaderPage l={route.l} s={route.s} />}
        {route.page === "corpus" && <CorpusPage />}
        {route.page === "today" && <Today />}
        {route.page === "atlas" && <AtlasPage route={route} />}
        {route.page === "learn" && <Learn />}
        {route.page === "practice" && <Practice />}
        {route.page === "me" && <Me privateAvailable={privateAvailable} />}
        {route.page === "about" && <About />}
      </main>
      <GlobalCard />

      {!focus && (
        <footer className="footer">
          <Logo compact />
          <p>
            Musk 语料 · 个人自用 · 代码基于 <a href={UPSTREAM_URL} target="_blank" rel="noreferrer">Word Atlas</a>（MIT）· 词库文字 Word Atlas contributors —{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            （已修改：移除插画与录音）· 离线词典{" "}
            <a href="https://github.com/skywind3000/ECDICT" target="_blank" rel="noreferrer">
              ECDICT
            </a>
            （MIT）·{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>{" "}
            · <a href="#/about">关于</a>
          </p>
        </footer>
      )}

      {!focus && (
        <nav className="tabbar" aria-label="主导航">
          {NAV.map(({ page, label, icon: Icon }) => (
            <a key={page} href={page === "musk" ? "#/" : `#/${page}`} className={navOn(route.page, page) ? "is-on" : ""} aria-current={navOn(route.page, page) ? "page" : undefined}>
              <Icon size={22} strokeWidth={navOn(route.page, page) ? 2.1 : 1.7} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      )}

      <WordSheet id={word} />
      <Palette open={palette} onClose={() => setPalette(false)} />
      {!onboarded && route.page !== "about" && route.page !== "musk" && route.page !== "reader" && route.page !== "corpus" && route.page !== "today" && !splash && <Onboarding />}
      {splash && <Splash onDone={() => setSplash(false)} />}
      <Toasts />
      <AmbienceController />
    </div>
  );
}

function WordSheet({ id }: { id: string | null }) {
  const atlas = useAtlas();
  const opened = id !== null;
  useEffect(() => {
    if (opened && store.get().settings.sfx) void cue("page");
  }, [opened]);
  const { entry, error } = useEntry(id);
  const ref = id ? atlas.byId.get(id) : undefined;
  const neighbor = useCallback(
    (d: number) => {
      if (!ref) return;
      const n = atlas.words[ref.order + d];
      if (n) go(currentLocation().route, n.id, true);
    },
    [atlas, ref],
  );
  useEffect(() => {
    if (!id) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowLeft") neighbor(-1);
      if (e.key === "ArrowRight") neighbor(1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, neighbor]);
  return (
    <Sheet open={!!id} onClose={closeWord} label={ref ? `${ref.word} 词条` : "词条"} wide>
      {entry ? (
        <EntryView key={entry.id} entry={entry} />
      ) : error ? (
        <p className="sheet-error">{error}</p>
      ) : (
        <span className="spinner" />
      )}
      {ref && (
        <nav className="sheet-nav" aria-label="切换词条">
          <button className="icon-btn" onClick={() => neighbor(-1)} disabled={ref.order === 0} aria-label="上一个">
            <ChevronLeft size={20} />
          </button>
          <span>
            {(ref.order + 1).toLocaleString()} / {atlas.count.toLocaleString()}
          </span>
          <button className="icon-btn" onClick={() => neighbor(1)} disabled={ref.order >= atlas.count - 1} aria-label="下一个">
            <ChevronRight size={20} />
          </button>
        </nav>
      )}
    </Sheet>
  );
}

export { openWord };
