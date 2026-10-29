// Safety Gate（makeSafetyGate）のチェック
//
// アプリの走行シミュレーター（simulate）で、ミスあり・周りの車ありの走行を流し、
// 評価 → 指導AI → Safety Gate の順に通して、次のことを確かめる。
//   1. 危険の状態（安全監視の反応中・直後）に、指導（check 以外）が1件も出ていない
//   2. 高負荷のときに、長い促し・予告・振り返りが出ていない
//   3. Gate が止めた・捨てた指導は、指導AIの記録で「言っていない」（delivered=false）になっている
//   4. Gate の中でエラーが起きたら、check 以外がすべて止まる
//
// 使い方:  node sim/gate_check.js [走行回数（1条件あたり）]

const { loadEngine } = require("./engine");
const E = loadEngine();

const RUNS = +process.argv[2] || 5;
const PROFS = ["standard", "practice", "abort"];
const problems = [];
const total = { runs: 0, samples: 0, danger: 0, high: 0, pass: 0, block: 0, defer: 0, release: 0, expire: 0 };
const byWhy = {};

function check(cond, msg) {
  if (!cond && problems.length < 20) problems.push(msg);
  if (!cond) problems.count = (problems.count || 0) + 1;
}

for (const ck of Object.keys(E.COURSES)) {
  const course = E.buildCourse(ck, {});
  for (const pk of PROFS) {
    for (const traffic of [false, true]) {
      for (let seed = 1; seed <= RUNS; seed++) {
        const prof = Object.assign({}, E.PROFILES[pk], { traffic });
        const smp = E.simulate(course, prof, seed);
        const mon = E.makeMonitor(course, {});
        const coach = E.makeCoach(course, {});
        const bandit = seed % 2 ? E.makeBandit(E.newBanditPop()) : null;
        const T = E.makeTeacher(course, E.newLearner(), bandit ? { bandit } : {});
        const G = E.makeSafetyGate(course, {}, { onGate: (m, info) => T.gated(m, info) });
        const tag = `${ck}/${pk}${traffic ? "/車あり" : ""}/seed${seed}`;
        smp.forEach((q) => {
          const alarms = mon(q);
          const out = G.step(T.step(coach(q), q), q, alarms);
          const st = G.state();
          total.samples++;
          if (st.load === "danger") total.danger++;
          if (st.load === "high") total.high++;
          if (st.load !== "normal") st.why.forEach((w) => (byWhy[w] = (byWhy[w] || 0) + 1));
          out.forEach((m) => {
            if (m.type === "check") return;
            check(st.load !== "danger", `${tag} t=${q.t.toFixed(1)}：危険の状態で「${m.text}」が出た`);
            if (st.load === "high") {
              check(m.type !== "pre" && m.type !== "review", `${tag} t=${q.t.toFixed(1)}：高負荷で${m.type}が出た`);
              check(!(m.key === "remind"), `${tag} t=${q.t.toFixed(1)}：高負荷で前回の課題が出た`);
            }
          });
        });
        G.finish(smp[smp.length - 1].t);
        G.log.forEach((x) => (total[x.verdict] = (total[x.verdict] || 0) + 1));
        // 止めた・捨てた指導が、指導AIの記録で「言っていない」になっているか
        G.log.filter((x) => (x.verdict === "block" || x.verdict === "expire") && x.did != null).forEach((x) => {
          const d = T.log[x.did];
          if (d.action === "say") check(d.delivered === false, `${tag}：止めた指導（判断 ${x.did}）が言ったことになっている`);
          check(d.gate === x.verdict, `${tag}：判断 ${x.did} に Gate の結果が記録されていない`);
        });
        total.runs++;
      }
    }
  }
}

// エラー時は check 以外を止める
{
  const course = E.buildCourse(Object.keys(E.COURSES)[0], {});
  const G = E.makeSafetyGate(course, {});
  const msgs = [{ type: "voice", kind: "hint", text: "テスト" }, { type: "check", key: "x" }, { type: "review", text: "テスト" }];
  const out = G.step(msgs, null, []);
  check(out.length === 1 && out[0].type === "check", "エラー時に check 以外が通った");
  check(G.summary().errors === 1, "エラーが数えられていない");
}

const pct = (n) => `${((n / total.samples) * 100).toFixed(1)}%`;
console.log(`Safety Gate（${E.GATE_VER}）チェック：走行 ${total.runs}本（コース ${Object.keys(E.COURSES).length} × ${PROFS.join("・")} × 周りの車なし/あり × ${RUNS}本）`);
console.log(`  サンプル ${total.samples}件：危険 ${pct(total.danger)}・高負荷 ${pct(total.high)}`);
console.log(`  指導の扱い：通した ${total.pass} / 止めた ${total.block} / 後回し ${total.defer}（あとで出した ${total.release}・捨てた ${total.expire}）`);
console.log(`  負荷が上がった理由（サンプル数）：` + Object.entries(byWhy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("、"));
if (problems.count) {
  console.log(`\n✗ 問題 ${problems.count}件`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}
console.log("\n✓ 危険の状態で出た指導 0件、高負荷で出た長い指導 0件、止めた指導はすべて「言っていない」として記録");
