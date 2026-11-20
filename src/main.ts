import "./style.css";
import { searchStreamers } from "./model/search.ts";
import {
  type Streamer,
  formatDate,
  liveRoomUrl,
  loadLastSwept,
  loadStreamers,
  oshiColor,
  resetAllSwept,
} from "./model/streamers.ts";
import { type GraveStatus, GraveApp } from "./scene/app.ts";

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
<div class="stage" id="stage"></div>

<header class="search">
  <input id="q" type="search" placeholder="搜索 UID 或名字…" autocomplete="off" spellcheck="false" />
  <ul id="results" hidden></ul>
</header>

<section class="card">
  <div id="intro">
    <p class="eyebrow">毕业纪念园</p>
    <h1 id="count">加载中…</h1>
    <p class="muted" id="introText">墓碑按名单顺序从入口往里排列，每逢新的毕业年份另起一排。拖动浏览，点击任意墓碑或搜索 UID / 名字前往扫墓。</p>
  </div>
  <div id="detail" hidden>
    <button id="back" class="back" type="button">← 返回墓园</button>
    <p class="eyebrow" id="uid"></p>
    <h1 id="name"></h1>
    <p class="meta"><a id="room" target="_blank" rel="noopener noreferrer"></a></p>
    <p class="meta" id="dates"></p>
    <p class="days" id="days"></p>
    <ul class="stats">
      <li><span>灰尘</span><i><b id="dust"></b></i></li>
      <li><span>苔藓</span><i><b id="moss"></b></i></li>
      <li><span>杂草</span><em id="weeds"></em></li>
      <li><span>擦拭</span><i class="clean"><b id="clean"></b></i></li>
    </ul>
    <p class="hint" id="hint"></p>
  </div>
</section>

<div class="label" id="label" hidden></div>

<section class="lab">
  <p class="eyebrow">实验面板</p>
  <label>时间快进 <output id="offsetLabel">+0 天</output>
    <input id="offset" type="range" min="0" max="365" value="0" />
  </label>
  <div class="row">
    <label class="check"><input id="outline" type="checkbox" checked />描边</label>
    <label class="check"><input id="dof" type="checkbox" checked />景深</label>
    <label class="check"><input id="petals" type="checkbox" checked />樱花</label>
  </div>
  <button id="reset" type="button">重置扫墓数据</button>
</section>

<div class="toast" id="toast"></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  let streamers: Streamer[];
  try {
    streamers = await loadStreamers();
  } catch (err) {
    $("count").textContent = "墓园暂时无法打开";
    $("introText").textContent = err instanceof Error ? err.message : String(err);
    return;
  }

  $("count").textContent = `${streamers.length} 位毕业的主播`;
  const app = new GraveApp($("stage"), streamers);

  // ---- Focus card -------------------------------------------------------
  app.onFocusChange = (s) => {
    $("intro").hidden = !!s;
    $("detail").hidden = !s;
    history.replaceState(
      null,
      "",
      s ? `#uid=${encodeURIComponent(s.uid)}` : location.pathname + location.search,
    );
    if (!s) return;
    document.documentElement.style.setProperty("--oshi", oshiColor(s));
    $("uid").textContent = `UID ${s.uid}`;
    $("name").textContent = s.name;
    const room = $<HTMLAnchorElement>("room");
    room.hidden = !s.roomId;
    room.textContent = `B站直播间 ${s.roomId} ↗`;
    room.href = liveRoomUrl(s);
    $("dates").textContent = [
      s.debutAt && `出道 ${formatDate(s.debutAt)}`,
      s.graduatedAt && `毕业 ${formatDate(s.graduatedAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  app.onStatus = (s: GraveStatus | null) => {
    if (!s) return;
    const { days, dust, moss } = s.weathering;
    $("days").textContent = days < 1 ? "今天刚有人来扫过墓" : `距上次扫墓 ${Math.floor(days)} 天`;
    $("dust").style.width = `${Math.round(dust * 100)}%`;
    $("moss").style.width = `${Math.round(moss * 100)}%`;
    $("weeds").textContent = s.weeds ? `${s.weeds} 丛` : "无";
    $("clean").style.width = `${Math.round(s.cleaned * 100)}%`;
    const todo: string[] = [];
    if (s.needsWipe && s.cleaned < 1) todo.push("按住拖动擦拭墓碑");
    if (s.weeds) todo.push("点击杂草拔除");
    $("hint").textContent = todo.length ? `${todo.join("，")}。` : "墓碑很干净，留下一束花吧。";
  };

  app.onSwept = (s) => {
    const toast = $("toast");
    toast.textContent = `扫墓完成，${s.name} 收到了你的花 🌸`;
    toast.classList.remove("show");
    void toast.offsetWidth;
    toast.classList.add("show");
  };

  // ---- Hover label ------------------------------------------------------
  const label = $("label");
  app.onHover = (s, x, y) => {
    label.hidden = !s;
    if (!s) return;
    if (label.dataset.uid !== s.uid) {
      label.dataset.uid = s.uid;
      label.textContent = s.name;
      label.style.setProperty("--c", oshiColor(s));
    }
    label.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  };

  $("back").addEventListener("click", () => app.overview());

  // ---- Search -----------------------------------------------------------
  const q = $<HTMLInputElement>("q");
  const results = $<HTMLUListElement>("results");
  let matches: Streamer[] = [];

  const go = (s: Streamer) => {
    app.focus(s.uid);
    q.value = "";
    results.hidden = true;
    q.blur();
  };

  const renderResults = () => {
    matches = searchStreamers(streamers, q.value);
    results.replaceChildren(
      ...(matches.length
        ? matches.map((s) => {
            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            const dot = document.createElement("i");
            dot.style.background = oshiColor(s);
            const name = document.createElement("span");
            name.textContent = s.name;
            const uid = document.createElement("small");
            uid.textContent = `UID ${s.uid}`;
            btn.append(dot, name, uid);
            btn.addEventListener("click", () => go(s));
            li.append(btn);
            return li;
          })
        : [
            Object.assign(document.createElement("li"), {
              className: "empty",
              textContent: "没有找到这位主播",
            }),
          ]),
    );
    results.hidden = !q.value.trim();
  };

  q.addEventListener("input", renderResults);
  q.addEventListener("focus", renderResults);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && matches[0]) go(matches[0]);
    if (e.key === "Escape") {
      q.value = "";
      results.hidden = true;
      q.blur();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".search")) results.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement !== q) app.overview();
  });

  // ---- Deep links: #uid=123 ---------------------------------------------
  const fromHash = () => {
    const uid = new URLSearchParams(location.hash.slice(1)).get("uid");
    if (uid) app.focus(uid);
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();

  // ---- Lab panel --------------------------------------------------------
  $<HTMLInputElement>("offset").addEventListener("input", (e) => {
    const days = Number((e.target as HTMLInputElement).value);
    $("offsetLabel").textContent = `+${days} 天`;
    app.setTimeOffset(days);
  });
  $<HTMLInputElement>("outline").addEventListener("change", (e) => {
    app.setOutline((e.target as HTMLInputElement).checked);
  });
  $<HTMLInputElement>("dof").addEventListener("change", (e) => {
    app.setDof((e.target as HTMLInputElement).checked);
  });
  $<HTMLInputElement>("petals").addEventListener("change", (e) => {
    app.setPetals((e.target as HTMLInputElement).checked);
  });
  $("reset").addEventListener("click", () => {
    resetAllSwept();
    $<HTMLInputElement>("offset").value = "0";
    $("offsetLabel").textContent = "+0 天";
    app.setTimeOffset(0);
    app.reload(loadLastSwept);
  });
}

void main();
