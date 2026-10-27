// 指導に反応する生徒シミュレーター
//
// アプリの走行シミュレーター（simulate）は、あらかじめ決めたミスを含む走行データを作るだけで、
// 指導を聞いても上達しない。ここでは「チェック結果のレベル」で生徒を表し、
// 促し・予告・振り返りを受けると能力が変わる仮想の生徒を作る。
// 指導AI（makeTeacher）には、本物の評価と同じ形のメッセージ（pre / voice / check / review）を渡す。
//
// 使い方:  node sim/student_sim.js [生徒数] [教習回数]
//
// 注意: 生徒の反応の仕方（上達量など）はすべて仮置きの値。結果は「ルールの違いでどう変わるか」を
// 比べるためのもので、実際の教習効果を示すものではない。

const { loadEngine } = require("./engine");
const E = loadEngine();

// ---------- 乱数（再現できるように seed つき） ----------
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

// ---------- 生徒のタイプ（仮置き） ----------
// boost   : 促し・予告を受けたその回だけ上がる量（指導ありならできる）
// hinted  : 促しを受けてできたときの定着量（小さいほど依存しやすい）
// self    : 促しなしで自分でできたときの定着量
// review  : 振り返りで指摘されたときの上達量
// explain : 理由まで説明されたときの上達量
// practice: 走るだけで上達する量 / forget: 教習の間に忘れる量
const PROFILES = {
  dependent: { name: "促しに頼りやすい", base: 0.45, boost: 0.35, hinted: 0.01, self: 0.07, review: 0.03, explain: 0.05, practice: 0.01, forget: 0.03 },
  explain: { name: "説明が効く", base: 0.45, boost: 0.2, hinted: 0.03, self: 0.04, review: 0.04, explain: 0.12, practice: 0.01, forget: 0.03 },
  selfled: { name: "自力で伸びる", base: 0.5, boost: 0.15, hinted: 0.02, self: 0.08, review: 0.02, explain: 0.03, practice: 0.02, forget: 0.02 },
};

// ---------- 評価項目の一覧（本物のコースとチェックから作る） ----------
// 優秀な生徒の走行を本物の評価に通し、区間ごとに出てくるチェック項目（閾値・単位つき）を集める。
function buildCatalog(courseKey) {
  const course = E.buildCourse(courseKey, {});
  const coach = E.makeCoach(course, {});
  const secs = {};
  E.simulate(course, E.PROFILES.excellent, 1).forEach((q) =>
    coach(q).forEach((m) => {
      if (m.type !== "check") return;
      const s = (secs[m.sec] = secs[m.sec] || { id: m.sec, scene: m.scene, items: {} });
      if (!s.items[m.key])
        s.items[m.key] = { key: m.key, skill: m.skill, label: m.text, fix: m.fix || "", threshold: m.threshold, unit: m.unit, dir: m.dir };
    })
  );
  const order = course.secs.map((x) => x.id).filter((id) => secs[id]);
  return {
    course,
    secs: order.map((id) => {
      const type = course.secs.find((x) => x.id === id).type;
      return { ...secs[id], type, items: Object.values(secs[id].items) };
    }),
  };
}

// 必ず出る促し（場面に入ると毎回言う）と、生徒が遅れているときだけ出る促しを分ける
const UNCONDITIONAL_HINTS = new Set(["go"]);

// ---------- 仮想の生徒 ----------
class VirtualStudent {
  constructor(profile, r) {
    this.p = profile;
    this.r = r;
    this.ability = {}; // 「場面:項目」ごとの能力 0〜1
  }
  a(ik) {
    if (this.ability[ik] == null) this.ability[ik] = Math.min(0.9, Math.max(0.1, this.p.base + this.r.gauss() * 0.12));
    return this.ability[ik];
  }
  learn(ik, amount) {
    const a = this.a(ik);
    this.ability[ik] = Math.min(0.98, a + amount * (1 - a));
  }
  // 能力に揺らぎを足した「その回の出来」。0.5以上なら合格
  intent(ik) {
    return this.a(ik) + this.r.gauss() * 0.12;
  }
  forget() {
    for (const k in this.ability) this.ability[k] -= this.p.forget * this.ability[k];
  }
}

// 出来（0〜1）を、本物のチェックと同じ形（value / threshold / margin / ok）に変換する
function toCheck(item, perf) {
  const rel = (perf - 0.5) * 2; // 0.5 で閾値ちょうど、+1 で閾値の100%余裕
  if (item.threshold == null) return { ok: perf >= 0.5, value: null, margin: null, detail: "" };
  const th = Array.isArray(item.threshold) ? item.threshold : item.threshold;
  const scale = Array.isArray(th) ? Math.abs(th[1] - th[0]) / 2 : Math.abs(th) || 1;
  let margin = Math.round(rel * scale * 1000) / 1000;
  if (item.dir === "lt" && margin === 0) margin = -0.001;
  const value =
    item.dir === "ge" ? th + margin : item.dir === "range" ? th[1] - margin : th - margin;
  const ok = item.dir === "lt" ? margin > 0 : margin >= 0;
  return { ok, value: Math.round(value * 1000) / 1000, margin, detail: `${Math.round(value * 100) / 100}${item.unit || ""}` };
}

// ---------- 指導の出し方（比べる3通り） ----------
// rule   : 指導AI rule_v0.1（makeTeacher）
// always : 元の指導モデルのまま。促しは全部言い、振り返りは最初に見つかった不合格を伝える
// silent : 何も言わない（走るだけ）
function makePolicy(kind, course, learner) {
  if (kind === "rule") {
    const T = E.makeTeacher(course, learner);
    return {
      // 渡したメッセージのうち、言ったもの・決めたことを返す
      run(msgs, t) {
        const before = T.log.length;
        const out = T.step(msgs, { t });
        return { out, decisions: T.log.slice(before) };
      },
      finish: () => T.finish(),
      log: T.log,
    };
  }
  return {
    run(msgs) {
      if (kind === "silent") return { out: msgs.filter((m) => !(m.type === "voice" && m.kind === "hint")), decisions: [] };
      const decisions = [];
      msgs.forEach((m) => {
        if (m.type === "review") {
          const ng = m.items.find((i) => !i.ok);
          if (ng) decisions.push({ kind: "review", keys: [ng.key], rule: "orig", action: "say" });
        }
      });
      return { out: msgs, decisions };
    },
    finish: () => null,
    log: [],
  };
}

// ---------- 1回の教習 ----------
function runLesson(cat, student, policy, r) {
  const stat = { attempts: 0, ok: 0, selfOk: 0, voice: 0, reviews: 0 };
  let t = 0;
  for (const sec of cat.secs) {
    t += 10;
    const base = { sec: sec.id, scene: sec.scene };
    const helped = {};

    // 予告（同じ場面で続けて失敗していれば、指導AIが一言足す）
    const pre = policy.run([{ type: "pre", ...base, text: `${sec.scene}の予告` }], t);
    pre.decisions.filter((d) => d.kind === "remind").forEach((d) => d.keys.forEach((k) => (helped[k] = 0.7)));
    stat.voice += pre.out.filter((m) => m.type === "voice").length;

    // その場の出来（促しの前）
    const intent = {};
    sec.items.forEach((it) => (intent[it.key] = student.intent(`${sec.type}:${it.key}`)));

    // 促し：必ず出るものと、遅れているときだけ出るもの
    const hintMap = E.HINT_FOR[sec.type] || {};
    for (const [hk, keys] of Object.entries(hintMap)) {
      const present = keys.filter((k) => intent[k] != null);
      if (!present.length) continue;
      const wanted = UNCONDITIONAL_HINTS.has(hk) || present.some((k) => intent[k] < 0.55);
      if (!wanted) continue;
      t += 1;
      const res = policy.run([{ type: "voice", kind: "hint", ...base, key: hk, text: `${sec.scene}の促し(${hk})` }], t);
      if (res.out.some((m) => m.type === "voice")) {
        stat.voice++;
        present.forEach((k) => (helped[k] = Math.max(helped[k] || 0, 1)));
      }
    }

    // チェック（促しを受けた項目はその回だけ出来が上がる）
    t += 2;
    const items = sec.items.map((it) => {
      const ik = `${sec.type}:${it.key}`;
      const h = helped[it.key] || 0;
      const perf = intent[it.key] + h * student.p.boost * (1 - student.a(ik));
      const c = toCheck(it, perf);
      return { ...it, ...c, ik, helped: h > 0 };
    });
    const checks = items.map((i) => ({
      type: "check", ...base, text: i.label, key: i.key, skill: i.skill, ok: i.ok, detail: i.detail, fix: i.fix,
      value: i.value, threshold: i.threshold, unit: i.unit, dir: i.dir, margin: i.margin,
    }));
    const ng = items.filter((i) => !i.ok);
    const review = {
      type: "review", ...base, text: `${sec.scene}の振り返り`, good: !ng.length, fixes: ng.map((i) => i.fix),
      items: items.map((i) => ({ key: i.key, skill: i.skill, ok: i.ok, label: i.label, detail: i.detail, fix: i.fix, value: i.value, threshold: i.threshold, unit: i.unit, dir: i.dir, margin: i.margin })),
    };
    const res = policy.run([...checks, review], t);

    // 上達：走るだけ / 自分でできた / 促しでできた
    items.forEach((i) => {
      stat.attempts++;
      if (i.ok) stat.ok++;
      if (i.ok && !i.helped) stat.selfOk++;
      student.learn(i.ik, student.p.practice);
      if (i.ok) student.learn(i.ik, i.helped ? student.p.hinted : student.p.self);
    });
    // 振り返りで指摘された項目
    res.decisions
      .filter((d) => d.kind === "review" && d.rule !== "V6")
      .forEach((d) => {
        stat.reviews++;
        const amount = d.rule === "V2" || d.rule === "V1" ? student.p.explain : student.p.review;
        d.keys.forEach((k) => student.learn(`${sec.type}:${k}`, amount));
      });
  }
  return stat;
}

// ---------- 実験 ----------
function experiment({ students = 200, lessons = 10, seed = 1 } = {}) {
  const cats = [buildCatalog("c1"), buildCatalog("c2")];
  const results = {};
  const stateCount = {};
  let decisionsWithState = 0;

  for (const [pk, prof] of Object.entries(PROFILES)) {
    for (const pol of ["rule", "always", "silent"]) {
      const per = Array.from({ length: lessons }, () => ({ attempts: 0, ok: 0, selfOk: 0, voice: 0, reviews: 0 }));
      for (let s = 0; s < students; s++) {
        const r = rng(seed * 100003 + s * 7919 + pk.length);
        const student = new VirtualStudent(prof, r);
        const learner = E.newLearner(`sim-${pk}-${s}`);
        for (let l = 0; l < lessons; l++) {
          const cat = cats[l % cats.length];
          const policy = makePolicy(pol, cat.course, learner);
          const st = runLesson(cat, student, policy, r);
          policy.finish();
          if (pol === "rule")
            policy.log.forEach((d) =>
              Object.values(d.state).forEach((sv) => {
                stateCount[sv.stateKey] = (stateCount[sv.stateKey] || 0) + 1;
                decisionsWithState++;
              })
            );
          for (const k in st) per[l][k] += st[k];
          student.forget();
        }
      }
      results[`${pk}/${pol}`] = per.map((x) => ({
        okRate: x.ok / x.attempts,
        selfRate: x.selfOk / x.attempts,
        voice: x.voice / students,
        reviews: x.reviews / students,
      }));
    }
  }
  return { results, stateCount, decisionsWithState };
}

// ---------- 表示 ----------
function pct(x) {
  return `${Math.round(x * 100)}%`.padStart(4);
}

if (require.main === module) {
  const students = +(process.argv[2] || 200);
  const lessons = +(process.argv[3] || 10);
  const t0 = Date.now();
  const { results, stateCount, decisionsWithState } = experiment({ students, lessons });
  const POL = { rule: "指導AI（rule_v0.1）", always: "元の指導（全部言う）", silent: "何も言わない　　　　" };
  console.log(`生徒 ${students}人 × 教習 ${lessons}回（コース c1/c2 を交互）  ${((Date.now() - t0) / 1000).toFixed(1)}秒\n`);
  console.log("自力合格率 = 促し・予告なしで合格した割合（最終的に目指すもの）");
  console.log("促し/回    = 1回の教習で声に出した促し・予告の数\n");
  for (const [pk, prof] of Object.entries(PROFILES)) {
    console.log(`■ ${prof.name}`);
    console.log("  指導の出し方         | 1回目 自力 促し/回 | 最終回 合格 自力 促し/回");
    for (const pol of ["rule", "always", "silent"]) {
      const r = results[`${pk}/${pol}`];
      const a = r[0];
      const z = r[r.length - 1];
      console.log(
        `  ${POL[pol]} |       ${pct(a.selfRate)} ${a.voice.toFixed(1).padStart(6)} |        ${pct(z.okRate)} ${pct(z.selfRate)} ${z.voice.toFixed(1).padStart(6)}`
      );
    }
    console.log("");
  }
  const keys = Object.entries(stateCount).sort((a, b) => b[1] - a[1]);
  const counts = keys.map((x) => x[1]).sort((a, b) => a - b);
  console.log(`■ 段階評価でまとめた「状態」の数（指導AIの判断 ${decisionsWithState} 件）`);
  console.log(`  使われた状態: ${keys.length} 通り（上限 5段階×3傾き×2自立＋新規 = 31）`);
  console.log(`  1つの状態あたりの件数: 中央値 ${counts[Math.floor(counts.length / 2)]} 件 / 最少 ${counts[0]} 件`);
  console.log(`  多い順: ${keys.slice(0, 6).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

module.exports = { experiment, buildCatalog, VirtualStudent, PROFILES, toCheck };
