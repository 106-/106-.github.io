// js/rd/main.js
(function () {
  "use strict";

  // --- グリッド・キャンバスの基本設定 ---
  var cellSize = 5; // 1タイルのサイズ（正方形）
  var cols, rows;
  var grid; // 各セルは 0 (ブロック：濃いグレイ) または 1 (背景：薄いグレイ)

  // --- ボルツマンマシン（Isingモデル風）のパラメータ ---
  // ※ initGrid() が初期化時に updateCell() を呼ぶため、これらの定数は
  //    resizeCanvas() の初回実行より前に評価されている必要がある
  var J = 1.0; // 結合定数（隣接セルとの相互作用）

  // 逆温度βは固定せず、臨界点をまたいで周期的に振動させる。
  // βを秩序相に固定するとドメインが粗大化し続け、数分で画面が単色に固まって
  // 動かなくなってしまう。βを往復させると、秩序⇄無秩序の相転移そのものが
  // 繰り返し画面に現れる。
  //
  // この8近傍格子（king's graph）は非平面なのでOnsagerの厳密解が使えず、
  // 臨界点は数値的にしか分からない。Wolffクラスタ法とBinderキュムラントの
  // サイズ交点（L=16〜48）で測ると β_c ≈ 0.191（kT_c/J ≈ 5.23）。
  // 最近接のみの正方格子の 0.4407 とは別物で、近傍が倍あるぶん半分以下になる。
  var BETA_CENTER = 0.225; // 振動の中心（β_cの約1.18倍＝臨界点のすぐ上）
  var BETA_AMP = 0.125; // 振幅 → βは 0.10（融解）〜 0.35（凍結）を往復
  var BETA_FROZEN = BETA_CENTER + BETA_AMP; // 凍結相のβ（初期化の馴染ませに使う）
  var PERIOD_SEC = 33.3; // 相転移1周期の秒数
  var beta = BETA_FROZEN; // 逆温度（1/T）。animate()で毎フレーム更新する

  // 物理の進行速度。1 MCS（モンテカルロステップ）= 全セルを平均1回更新する時間。
  // 3 MCS/秒 は従来の「60fpsで毎フレーム5%更新」と同じ速さ（0.05 × 60 = 3.0）。
  // 更新量を経過時間に比例させることで、リフレッシュレートが違う環境でも
  // 相転移の周期と物理の進み方が一致する。
  var MCS_PER_SEC = 3.0;
  var MAX_DT = 0.1; // タブ復帰直後などにdtが跳ね、一度に大量更新が走るのを防ぐ

  // 経過時間。位相を1/4周期ぶん進めた状態から始めることで、βが最大＝最も
  // 凍結した状態でスタートし、初期の斑がまず凍ったまま見えるようにする。
  var elapsed = PERIOD_SEC / 4;

  // --- 初期状態（凍結後の斑模様）の生成パラメータ ---
  // 一度融解してから凍結するとできる、あの不規則な牛柄の斑を初期状態にする。
  // 本物の粗大化（ランダム初期状態を低温で緩和）でも同じものが得られるが、
  // L(t) ~ t^(1/2) と遅いので、低解像度の乱数を滑らかに補間して2値化し、
  // 粗大化の到達点を直接作っている。
  // BLOB_SIZE=12 は、温度振動が一巡して再凍結したときの斑の細かさ
  // （壁密度 0.068〜0.072 / 径14〜15セル）に一致するよう実測で合わせた値。
  var BLOB_SIZE = 12; // 斑の典型サイズ（セル単位）
  var BLOB_OCTAVES = 2; // 重ねる周波数の数。界面に細かいゆらぎを与える
  var BURN_IN_MCS = 8; // 生成後、凍結相で馴染ませるモンテカルロステップ数

  // キャンバス生成＆bodyへ追加
  var canvas = document.createElement("canvas");
  canvas.id = "canvas";
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");

  // 低解像度の乱数格子を滑らかに補間した値ノイズを返す。
  // 格子は周期的に読むので、できあがる模様も画面の端で連続し、
  // シミュレーション側の周期境界と食い違わない。
  function makeValueNoise(blobSize) {
    var gw = Math.max(2, Math.round(cols / blobSize));
    var gh = Math.max(2, Math.round(rows / blobSize));
    var lattice = new Array(gh);
    for (var y = 0; y < gh; y++) {
      lattice[y] = new Array(gw);
      for (var x = 0; x < gw; x++) {
        lattice[y][x] = Math.random();
      }
    }
    return function (r, c) {
      var gx = (c * gw) / cols;
      var gy = (r * gh) / rows;
      var x0 = Math.floor(gx);
      var y0 = Math.floor(gy);
      // smoothstepで補間すると格子点に折れ目が出ず、輪郭が有機的になる
      var tx = gx - x0;
      var ty = gy - y0;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);
      var x1 = (x0 + 1) % gw;
      var y1 = (y0 + 1) % gh;
      x0 = x0 % gw;
      y0 = y0 % gh;
      var top = lattice[y0][x0] * (1 - tx) + lattice[y0][x1] * tx;
      var bottom = lattice[y1][x0] * (1 - tx) + lattice[y1][x1] * tx;
      return top * (1 - ty) + bottom * ty;
    };
  }

  // 画面サイズに合わせてキャンバスとグリッドを初期化
  //
  // 初期状態はランダムではなく、一度融解した系が再び凍結したときにできる
  // 不規則な斑模様（牛柄）から始める。
  function initGrid() {
    cols = Math.floor(canvas.width / cellSize);
    rows = Math.floor(canvas.height / cellSize);

    // 周波数を倍・振幅を半分にしながら重ね、輪郭に細かいゆらぎを足す
    var noises = [];
    var amps = [];
    var totalAmp = 0;
    var size = BLOB_SIZE;
    var amp = 1;
    for (var o = 0; o < BLOB_OCTAVES; o++) {
      noises.push(makeValueNoise(size));
      amps.push(amp);
      totalAmp += amp;
      size /= 2;
      amp /= 2;
    }

    // まず全セルのノイズ値を求める
    var values = new Float64Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var v = 0;
        for (var i = 0; i < noises.length; i++) {
          v += amps[i] * noises[i](r, c);
        }
        values[r * cols + c] = v / totalAmp;
      }
    }

    // 閾値は固定の0.5ではなく実際の中央値を使う。ノイズ格子が粗くなる
    // 小さい画面では全格子点がたまたま0.5の同じ側に寄ることがあり、
    // 固定値で切ると画面が単色に潰れてしまう（実測でiPhone横向き40%）。
    // 中央値で切れば、どの画面サイズでも2つの相が必ず半々になる。
    var median = Float64Array.from(values).sort()[values.length >> 1];

    grid = new Array(rows);
    for (var gr = 0; gr < rows; gr++) {
      grid[gr] = new Array(cols);
      for (var gc = 0; gc < cols; gc++) {
        grid[gr][gc] = values[gr * cols + gc] > median ? 1 : 0;
      }
    }

    // 補間で作った輪郭は滑らかすぎるので、凍結相で少しだけ緩和して
    // Isingの界面らしい粗さを持たせる
    var burnIn = rows * cols * BURN_IN_MCS;
    for (var k = 0; k < burnIn; k++) {
      updateCell(
        Math.floor(Math.random() * rows),
        Math.floor(Math.random() * cols),
        BETA_FROZEN,
      );
    }
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    initGrid();
  }
  window.addEventListener("resize", resizeCanvas, false);
  resizeCanvas();

  // 指定したセル (r, c) のみ、逆温度 invTemp でGibbsサンプリング更新を行う
  function updateCell(r, c, invTemp) {
    var sum = 0;
    // 8近傍（上下左右＋斜め）の状態の合計を求める
    // ※内部では 0 を -1、1 を +1 として扱う
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        var nr = (r + dr + rows) % rows;
        var nc = (c + dc + cols) % cols;
        sum += 2 * grid[nr][nc] - 1;
      }
    }
    // 論理的には、セル i の s_i (±1) を更新する確率は
    //    P(s_i = +1) = 1/(1 + exp(-2 * beta * J * (∑_j s_j)))
    // として計算できるので、ここでは 0/1 の表現に合わせて変換
    var prob = 1 / (1 + Math.exp(-2 * invTemp * J * sum));
    // 確率 prob で状態を 1、そうでなければ 0 に更新
    grid[r][c] = Math.random() < prob ? 1 : 0;
  }

  // 経過時間に比例した数のセルをランダムに選んで更新する
  // 一度に全セルを走査せず少しずつ更新することで、負荷を分散させる
  function updateGrid(dt) {
    var numUpdates = Math.floor(rows * cols * MCS_PER_SEC * dt);
    for (var i = 0; i < numUpdates; i++) {
      var r = Math.floor(Math.random() * rows);
      var c = Math.floor(Math.random() * cols);
      updateCell(r, c, beta);
    }
  }

  // --- 描画処理 ---
  function drawGrid() {
    // キャンバス全体を薄いグレイ（背景色: 例 hsl(0, 0%, 90%)）で塗る
    ctx.fillStyle = "hsl(0, 0%, 90%)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 各セルを描画：セルの状態が 0 (ブロック) の場合、濃いグレイで塗る
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (grid[r][c] === 0) {
          var x = c * cellSize;
          var y = r * cellSize;
          ctx.fillStyle = "hsl(0, 0%, 30%)";
          ctx.fillRect(x, y, cellSize, cellSize);
        }
      }
    }

    // グリッド線の描画（セル境界を薄い線で表示）
    ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.lineWidth = 0.3;
    // 縦線
    for (var c = 0; c <= cols; c++) {
      var x = c * cellSize;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rows * cellSize);
      ctx.stroke();
    }
    // 横線
    for (var r = 0; r <= rows; r++) {
      var y = r * cellSize;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cols * cellSize, y);
      ctx.stroke();
    }
  }

  // --- アニメーションループ ---
  // 毎フレーム、逆温度を更新し、少しずつサンプリングしてからグリッドを描画する
  var lastTime = performance.now();

  function animate() {
    var now = performance.now();
    var dt = Math.min((now - lastTime) / 1000, MAX_DT);
    lastTime = now;
    elapsed += dt;

    // 逆温度を正弦波で往復させる（凍結 ⇄ 融解）
    beta =
      BETA_CENTER + BETA_AMP * Math.sin((2 * Math.PI * elapsed) / PERIOD_SEC);

    updateGrid(dt);
    drawGrid();
    requestAnimationFrame(animate);
  }
  animate();
})();
